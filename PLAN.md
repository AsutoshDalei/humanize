# PLAN.md — Humanizer web app

Local "humanize this text" web app: Go server + vanilla HTML/CSS/JS front end + llama.cpp serving `jialinyyzz/humanizer`.

Repo: `/home/asutoshdalei/projects/humanize`

---

## 1. Constraints (from the user)

- **Go** for the server, **vanilla HTML/CSS/JS** for the UI (no frameworks, no CDN, no build step).
- **Node.js must not be installed or used in any form.** No npm, no bundler, no third-party packages anywhere.
- **Go = standard library only** (`net/http`, `encoding/json`, `sync`, `os/exec`, …).
- Simple, minimalistic, **dark-themed** UI.
- One bash script starts llama.cpp **and** the web server together.
- In-memory store for history — "nothing sophisticated", no external DB.

## 2. Model facts (verified from HF docs + machine)

- Model: `jialinyyzz/humanizer`, GGUF file `humanizer-12b-IQ2_XS-QAT.gguf` (3,893,632,896 bytes, 2-bit).
- Path: `~/.cache/huggingface/hub/models--jialinyyzz--humanizer/snapshots/2e57b6528a4070c33f3e09ca24e3325a84272f68/humanizer-12b-IQ2_XS-QAT.gguf`
- Blob sha256 `383e5ca8…` matches the documented checksum → file is authentic and complete.
- **IQ2_XS-QAT is the smallest quant that exists.** Machine has 7 GB RAM / GTX 1650 4 GB VRAM, so Q3 (5.6 GB) and Q4_K_M (7.6 GB) will not fit. No smaller quant to switch to; the levers are `-ngl` tuning and SSE streaming.
- The 562 MB `.downloadInProgress` blob in `blobs/` is an aborted `Q4_K_M` download → delete it.

### Hard requirements from `AGENTS.md` / model card

| Aspect | Requirement |
|---|---|
| Endpoint | `POST /completion` (not the chat endpoint) |
| Prompt | `instr + "\n\n" + draft.strip() + "\n\n### Rewritten:\n\n"`, byte for byte |
| Checksum | `sha256(prompt("X"))[:16] == "cc51d66b4c593fbe"` (assert at startup) |
| Sampling | `temperature 1.0, top_p 0.95, top_k 0, min_p 0, repeat_penalty 1.0` — all explicit (llama defaults top_k 40 / min_p 0.05 are wrong) |
| Stop | EOS only — never send `stop` |
| Context | `-c 8192 -np 1` |
| `n_predict` | `clamp(2.5 × draftTokens, 256, 2048)` |
| Language check | English draft returning mostly Chinese → resample, up to 3 attempts |
| Fact check | Report numbers present in the draft but missing from the output — **report, never fix silently** |

The chat template stored in the GGUF ignores system prompts and takes only the last user message; irrelevant since we use `/completion` directly.

`instr` (embedded verbatim, no rewording):

```
Rewrite the text below so it reads like a person wrote it, not a language model.

Reorganize it as you see fit. Vary sentence length on purpose. Cut hedging,
throat-clearing, and any sentence that only announces what comes next.
Prefer the concrete word over the abstract one. It is fine to sound uneven.

Every fact, number, unit, date, name and quotation must survive unchanged.
```

`sep` = `"\n\n### Rewritten:\n\n"`.

## 3. Decisions approved by the user

1. `brew install go` (linuxbrew, v1.27.3, no sudo) — the only install. **No Node.js, ever.**
2. **Streaming via SSE** (text appears as the model generates).
3. **Both quality checks**: Chinese-output retry (≤3) **and** missing-number warning strip.
4. Ports: **llama-server `127.0.0.1:8080`** (official docs), **web app `127.0.0.1:8090`**.
5. Current test server on `:8081` gets stopped during implementation.

## 4. Architecture

```
humanize/
├── PLAN.md               this file
├── run.sh                start llama-server → wait /health → go build → start app → trap cleanup
├── server/main.go        net/http only: static files, /api/*, in-memory store, SSE
├── web/index.html        sidebar (history) + two-panel layout
├── web/style.css         dark, minimal, no framework
├── web/app.js            fetch + SSE parsing, session handling (vanilla)
└── scripts/selftest.sh   port of AGENTS.md §8 self-test
```

### Backend (`server/main.go`, single file, stdlib only)

- **Prompt builder** with the constants above; startup self-test on the sha256, abort loudly on mismatch.
- **`POST /api/humanize`** → `text/event-stream`:
  - builds the byte-exact prompt, POSTs to `http://127.0.0.1:8080/completion` with `stream: true` + the exact sampling block.
  - forwards tokens as SSE `token` events; final `done` event carries `{missingNumbers, retries, ms}`.
  - Checks: prompt echo / chat markers in output → error; Chinese-dominant output for an English draft → resample (≤3) and only stream the winning sample; `re.findall("\\d+", draft)` vs output → missing numbers reported in `done`.
  - `n_predict = clamp(2.5 × draftTokens, 256, 2048)`; never sends `stop`.
- **In-memory sessions**: `map[string]*Session` + `sync.RWMutex`; `Session = {id, title (first ~60 chars), createdAt, messages[]}`; created on first humanize.
  - `GET /api/sessions` — list
  - `GET /api/sessions/{id}` — full pair(s)
  - `DELETE /api/sessions/{id}`
  - No persistence anywhere.
- Serves `web/` via `http.FileServer`.

### Front end (vanilla, dark, minimal)

- Layout: **sidebar** (~240 px: title, `+ New`, history list with relative timestamps, hover delete) │ **input panel** (textarea, char/token hint, `Humanize`) │ **output panel** (streamed result, `Copy`, amber "numbers to check" strip, timing footer).
- CSS variables for the dark palette, system font stack. No frameworks, no CDN, no build step.
- `app.js`: manual SSE parsing over `fetch` + `ReadableStream` (EventSource cannot POST); disable button + animated busy state while streaming; history click loads the pair into both panels; `New` resets.

### Launcher (`run.sh`)

1. Preflight: `llama-server` on PATH, GGUF present, `go` present, ports 8080/8090 free (kill stale listeners).
2. Start `llama-server -m <gguf> -c 8192 -np 1 -ngl <tuned> --host 127.0.0.1 --port 8080` → `logs/llama.log`, poll `/health` until `{"status":"ok"}` (timeout ~120 s, print progress).
3. `go build -o bin/humanize ./server` → start app → poll health → print both URLs.
4. `trap` EXIT/INT/TERM → kill both cleanly. Support `./run.sh stop`.

## 5. Execution order

1. **Prereqs**: `brew install go`; stop the test server on `:8081`; delete the 562 MB partial blob.
2. **Benchmark `-ngl`** 20 → 30 → 40 on a fixed draft, watch `nvidia-smi` (4 GB VRAM, ~700 MB CUDA context overhead), pick the fastest stable value; baseline was `-ngl 20` → 3.9 tok/s gen / 5.4 tok/s prompt.
3. **Backend**: prompt builder + sha256 self-test → llama client with exact sampling + retries → session store → endpoints + SSE.
4. **Front end**: dark layout → sidebar history → humanize streaming flow → copy / warnings.
5. **`run.sh`** + `scripts/selftest.sh` (AGENTS.md §8: prompt hash, no prompt echo, no chat markers, copy rate, missing numbers).
6. **End-to-end**: cold boot via `run.sh`, browser flow — humanize → stream → history reload → delete → new.

## 6. Risks / caveats

- **Speed**: even tuned, ~4–10 tok/s; a 150-word paragraph ≈ 10–30 s. SSE makes it tolerable, not fast.
- **RAM is the ceiling** (7 GB total): llama-server + Go + browser must coexist; the 2-bit file is the only option, no headroom for a larger quant.
- **Fact slips are inherent** to the 2-bit file (70/420 flagged by the strict judge) → the numbers-warning strip is mandatory, and the UI should tell the user to proofread numbers, dates and names.
- Long/structured documents are out of scope (official advice there is `hz`); one draft per request must fit in 8192 tokens.

## 7. Results (verified 2026-10-25)

**Environment**: Go 1.27.3 (linuxbrew), llama.cpp 0.7.0 b11669, GTX 1650 4 GB, 7 GB RAM.
The 562 MB aborted `Q4_K_M` blob was deleted; `IQ2_XS-QAT` blob hash matches the documented `sha256sum`.

**`-ngl` benchmark** (fixed draft, `-c 8192 -np 1`, prompt t/s · gen t/s · VRAM):

| `-ngl` | prompt | gen | VRAM | verdict |
|---|---|---|---|---|
| 20 (initial) | 5.4 | 3.9 | 2356 MiB | baseline |
| 30 | 16.0 | 7.4 | 2928 MiB | |
| 35 | 20.4 | 8.1 | 3359 MiB | |
| **38** | **24.2** | **8.1** | **3610 MiB** | **shipped (486 MiB headroom)** |
| 39 | 26.0 | 8.1 | 3686 MiB | marginal gain, less headroom |
| 40 | — | — | — | CUDA OOM at load |

Net: prompt processing **4.8×** faster, generation **2.1×** faster than the initial run.

**Verification checklist**

- [x] `go vet` + `gofmt` clean; stdlib only (`go.mod` has zero requires)
- [x] Startup prompt self-test: `sha256(buildPrompt("X"))[:16] == cc51d66b4c593fbe`
- [x] Static UI served (`/`, `style.css`, `app.js` → 200)
- [x] `POST /api/humanize` streams `meta → token* → done`, streamed text == final text
- [x] `scripts/selftest.sh` → **PASS** on the AGENTS.md evaluation draft (1 attempt, no prompt echo, no chat markers, copy rate fine, numbers all survived)
- [x] Sessions: list / get / delete / 404, title from first draft, second draft appends to the same session
- [x] Validation: empty draft → 400, bad JSON → 400, >7400-token draft → 413 with a "split the text" message
- [x] `./run.sh` cold start, `status`, `stop`, `restart`, and `fg` + Ctrl+C cleanup all work
- [x] Front end: every `$("id")` in `app.js` exists in `index.html`; every class JS creates has CSS; server-supplied strings are escaped (no `innerHTML` of model output)

**Known behaviour**

- History is in-memory only — restarting clears it (as specified).
- Clicking a conversation loads its **latest** rewrite; `＋ New` starts a fresh one.
- The Chinese-output retry path is implemented but rarely triggers (it needs an English draft coming back ≥5% Chinese).

## 8. Contamination incident (2026-10-25)

**Report.** A response for an ordinary test prompt carried an unrelated block appended after a valid rewrite: the user's UI/design briefing (text written only for the coding agent — never intended for the model).

**Investigation (all negative before the fix):**

| Suspect | Evidence | Verdict |
|---|---|---|
| Instruction contaminated | `buildPrompt() = instr + draft + sep`; sha256 `cc51d66b4c593fbe` asserted at startup | clean |
| Text present on disk anywhere | grepped the whole home dir: exists only in opencode's prompt history | not reachable |
| Sent to the model by the agent | grepped every session tool-call payload for request bodies containing it | never sent |
| Server mixing requests | `handleHumanize` uses per-request locals only | clean |
| Embedded in the GGUF | binary grep for distinctive phrases: 0 hits | not present |
| Model hallucination | text was verbatim incl. its typo | impossible |

**Remaining carrier and fix.** `cache_prompt: true` let llama-server reuse KV state from earlier requests in its single slot — the only channel through which content from one request can appear inside a later one. Response: disable it, and add two layers so any recurrence is provable rather than anecdotal.

**What changed**

1. `CachePrompt: false` in `sampleParams()` — every request starts from empty KV; costs ~3 s of instruction re-scoring per run.
2. `run.sh` pins `--cache-reuse 0` on llama-server (was already the default; now explicit).
3. **Prompt ledger** — `-ledger logs/prompts.log`: every request logged with timestamp, session, byte length, sha256 and the exact prompt; every result logged with output sha256 and flags.
4. **Contamination guard** — rolling window of 64 draft signatures (first 60 normalised chars); a response containing a *different* draft's run is flagged (`contamination`) and shown as an error margin note; identical resubmission never flags.
5. **Overrun flag** — output > 2×draft+400 chars is flagged (`overrun`, `CHECK LENGTH` note): the signature of an appended block.
6. Copy-button fallback no longer overwrites a standing warning note (found by the browser test, not by inspection).

**Verification (obscura, `./obscura --help`, MCP + CDP)**

- [x] `go test ./server` — 4/4: guard fires on foreign text, silent on same-draft, overrun thresholds, prompt contract
- [x] `scripts/soak.py` — 3 alternating marker runs, zero cross-contamination, zero false positives, flags consistent
- [x] `scripts/uitest.py` — **36/36** browser checks: no console errors, no external requests, full streaming run, copy feedback, two-step delete + Escape, New-reset, drawer logic, focus-visible/reduced-motion declarations, announcements
- [x] Note-preservation test: a standing `VERIFY` warning survives a failed copy; clipboard advice appears only when nothing stands
- [x] Screenshots reviewed at 1440×900 and 1280×720 (layout, palette, serif prose, rails, footer alignment)
- [x] `scripts/selftest.sh` → PASS after every change

**obscura engine limits found while testing (engine, not app):** `ch` units do not resolve (an inline `max-width:66ch` computes to `none`), the viewport cannot be emulated (capture size ≠ layout size), CSS gradients are not painted (a solid box at the identical position paints; the coral wash and margin rule do not), and `:focus`/`:focus-visible` rules never apply (an injected `#el:focus` test rule is ignored too). These checks therefore assert stylesheet declarations; real browsers are unaffected. The engine did catch two genuine bugs: the menu/close buttons leaking onto desktop (`.icon-btn` specificity) and the copy fallback clobbering warnings.

