# Humanizer

A small local web app that rewrites AI-generated text so it reads like a person wrote it. Paste a draft on the left, press Humanize, and watch the rewrite stream in on the right. Past conversations are listed in a sidebar.

Everything runs on your own machine: a Go server, a browser page with no framework, and llama.cpp serving the `jialinyyzz/humanizer` model (12B, 2-bit GGUF, 3.9 GB). No cloud API, no Node.js, no third-party packages.

---

## Requirements

| Thing | Version on this machine | Notes |
|---|---|---|
| llama.cpp (`llama-server`) | 0.7.0 | `brew install llama.cpp` |
| Go | 1.27.3 | `brew install go`, standard library only |
| Model file | `humanizer-12b-IQ2_XS-QAT.gguf` | already in `~/.cache/huggingface/hub/` |
| NVIDIA GPU | GTX 1650, 4 GB | CPU-only also works, just slower |
| python3 | any | only for `scripts/selftest.sh` |
| bash, curl | any | for `run.sh` |

Node.js is deliberately not used and must not be installed.

## Quick start

```bash
./run.sh              # starts llama-server, then the web server
```

It prints the addresses when both are up:

```
  Humanizer is up:
    UI     http://127.0.0.1:8090
    llama  http://127.0.0.1:8080
```

Open the UI, paste some text, press Humanize (or Ctrl/Cmd + Enter).

Other commands:

```bash
./run.sh status       # is anything running?
./run.sh stop         # stop both
./run.sh restart      # stop, then start
./run.sh fg           # run in the foreground, Ctrl+C stops both
./run.sh logs         # follow llama.cpp and app logs
./run.sh help         # all commands, environment variables, examples
```

Logs and pid files live in `logs/`. The compiled binary goes to `bin/`.

## Project layout

```
.
├── PLAN.md               development plan and the recorded benchmark results
├── README.md             this file
├── run.sh                launcher: llama.cpp + web server, with pid files and cleanup
├── go.mod                module "humanize", no dependencies
├── server/
│   ├── main.go           the whole backend (one file, Go standard library)
│   └── main_test.go      unit tests: prompt contract, contamination guard
├── web/
│   ├── index.html        page structure
│   ├── style.css         dark theme
│   └── app.js            streaming, sessions, copy button (vanilla JS)
├── scripts/
│   ├── selftest.sh       end-to-end test against the model's own checklist
│   ├── soak.py           contamination soak: alternating marker drafts
│   └── uitest.py         browser test suite driven through obscura's MCP
├── obscura               headless browser used for all UI testing
├── bin/                  build output (git-ignored)
└── logs/                 llama.log, app.log, prompts.log, pid files (git-ignored)
```

## How it works

```
browser                Go server (":8090")              llama-server (":8080")
  |                          |                                 |
  |  POST /api/humanize      |                                 |
  |  {draft, sessionId}      |                                 |
  |------------------------->|  build the exact prompt         |
  |                          |  count draft tokens (/tokenize) |
  |                          |  pick n_predict                 |
  |                          |-------------------------------->|
  |                          |  POST /completion (stream)      |
  |                          |<--------------------------------|
  |  SSE: meta               |                                 |
  |<-------------------------|                                 |
  |  SSE: token ... token    |  (tokens forwarded as they land)|
  |<-------------------------|                                 |
  |  (language check: resample up to 3x if English -> Chinese) |
  |  (number check: digits in draft missing from the rewrite)  |
  |  SSE: done {text, missingNumbers, retries, ms}             |
  |<-------------------------|                                 |
  |                          |  append message to the          |
  |                          |  in-memory session store        |
```

The server serves the static page from `web/`, so one port gives you the whole app.

## The model contract

The model is a **text-completion** model, not a chat model. The rules below come from the model card and `AGENTS.md` in the Hugging Face repo, and the backend enforces all of them.

**Prompt** — built byte for byte as `instr + "\n\n" + draft.strip() + sep`:

```
Rewrite the text below so it reads like a person wrote it, not a language model.

Reorganize it as you see fit. Vary sentence length on purpose. Cut hedging,
throat-clearing, and any sentence that only announces what comes next.
Prefer the concrete word over the abstract one. It is fine to sound uneven.

Every fact, number, unit, date, name and quotation must survive unchanged.

<the draft>

### Rewritten:

```

At startup the server hashes this prompt with the draft `"X"` and refuses to run unless the first 16 hex characters of the SHA-256 are `cc51d66b4c593fbe`, the value published upstream. The check is logged on every boot: `prompt format OK (sha256 prefix cc51d66b4c593fbe)`.

**Sampling** — all of it sent explicitly, because llama.cpp's defaults differ from how the model was evaluated:

```json
{"temperature": 1.0, "top_p": 0.95, "top_k": 0, "min_p": 0,
 "repeat_penalty": 1.0, "n_predict": "<clamped>", "stream": true,
 "cache_prompt": false}
```

No `stop` string is ever sent; generation ends at EOS.

`cache_prompt` is deliberately `false`. When it is `true`, llama-server reuses KV state from earlier requests in its single slot (`-np 1`), which is the one channel through which content from an unrelated request can surface inside a later response. Disabling it costs a re-score of the ~95-token instruction per run (about 3 s) and guarantees every request starts from empty state. `run.sh` additionally pins `--cache-reuse 0` on llama-server.

**Budget** — `n_predict = clamp(2.5 x draftTokens, 256, 2048)`, the rule the model's own app uses. Token counts come from llama-server's `/tokenize`, so they are exact rather than estimated. Drafts over 7400 tokens are rejected with a message telling you to split the text, because the context is 8192 tokens.

**Post-checks**

1. *Language* — if an English draft comes back with a Chinese-heavy rewrite (10+ Han characters, more than 5% of the output), the server resamples with identical settings, up to 3 attempts. The UI shows a notice when this happens.
2. *Wiring* — if the output echoes the instruction, contains `### Rewritten`, or shows chat markers like `<start_of_turn>`, the request fails with an error instead of returning garbage.
3. *Facts* — every digit sequence in the draft is looked up in the rewrite. Any that vanished are returned in `missingNumbers` and shown as a warning strip. Nothing is edited silently; the model's text is passed through as-is.
4. *Contamination* — the first 60 normalised characters of every draft are remembered (a rolling window of 64). If a response contains a verbatim run belonging to a **different** draft, the response is flagged with `contamination` and the UI shows an error margin note. The same draft resubmitted never triggers it.
5. *Overrun* — a response longer than twice the draft plus 400 characters is flagged with `overrun`: the signature of a block appended after a normal rewrite. Reported as a `CHECK LENGTH` note; the text is never trimmed.

### Prompt ledger

Every request appends the exact prompt it sent to `logs/prompts.log` (enabled by the `-ledger` flag that `run.sh` passes), one line per request plus one line per result:

```
2026-10-25T23:35:38.201Z request session=9d83c3ea52cec323 bytes=1325 sha256=b34cbeaf… prompt="Rewrite the text below …"
2026-10-25T23:36:14.284Z result session=9d83c3ea52cec323 ms=36082 out_sha256=9c621f76… out_bytes=965 contam=none overrun=false
```

When a response ever looks wrong, the first question — what was actually in the prompt? — is answerable from disk. The ledger is the backstop that makes contamination attributable instead of mysterious.

## API

All bodies are JSON. Errors come back as `{"error": "..."}` with a 4xx/5xx status.

### `GET /api/health`

```json
{"ok": true, "llama": "ok"}
```

`llama` is `ok` only when the model server responds healthy.

### `POST /api/humanize`

```json
{"draft": "the text to rewrite", "sessionId": "optional-existing-session"}
```

Returns `text/event-stream`. Events:

| Event | Payload | Meaning |
|---|---|---|
| `meta` | `{sessionId, attempt, draftTokens}` | session assigned, stream starting |
| `token` | `{t}` | one generated chunk, append it |
| `retry` | `{attempt}` | previous attempt discarded, clear the panel |
| `done` | `{sessionId, messageId, attempts, retries, missingNumbers, ms, draftTokens, text, contamination, overrun}` | final result; `text` is authoritative |
| `error` | `{message}` | something went wrong |

Example:

```bash
curl -sN -X POST localhost:8090/api/humanize \
  -H 'Content-Type: application/json' \
  -d '{"draft":"The meeting was held on March 3 and attended by 12 people."}'
```

### `GET /api/sessions`

```json
{"sessions": [{"id": "…", "title": "…", "createdAt": "…", "updatedAt": "…", "count": 2}]}
```

Newest first.

### `GET /api/sessions/{id}`

```json
{"id": "…", "title": "…", "createdAt": "…", "updatedAt": "…",
 "messages": [{"id": "…", "draft": "…", "result": "…",
               "missingNumbers": [], "retries": 0, "ms": 14200, "createdAt": "…"}]}
```

Messages may also carry `contamination` (string) and `overrun` (bool) when a response was flagged, so reopening a conversation shows the same warnings it showed live.

### `DELETE /api/sessions/{id}`

```json
{"ok": true}
```

404 if the id is unknown.

## The page

**Layout.** A shared 56 px header and a shared 64 px footer span both columns, so the draft and the rewrite always start and end at exactly the same height — the two columns cannot drift apart. The middle is a two-column grid split at the centre hairline.

```
┌──────────┬──────────────────────────────────────────────────────────┐
│ brand    │  HEADER   conversation title …………… live run status · 2px progress │
│          ├───────────────────────────┬──────────────────────────────┤
│ + New    │  DRAFT            142 words│  REWRITTEN          1 pass  │
│          │                           │ │ margin rule                 │
│ CONVOS   │  serif, editable, 66ch     │ │ serif, read-only, 66ch      │
│  · item  │                           │ │ (margin note when needed)   │
│  · item  │                           │ │                            │
│          ├───────────────────────────┴──────────────────────────────┤
│ ● ready  │  FOOTER   Ctrl/⌘ + Enter ……………………        [Copy] [Humanize] │
└──────────┴──────────────────────────────────────────────────────────┘
```

- **Sidebar** — brand mark, `New rewrite`, then the conversation list: title (first 60 characters of the draft), relative time and rewrite count in mono. The active conversation is marked by a coral rail, not a filled pill. Status dot at the bottom shows `model ready` / `model offline`, polled every 30 seconds.
- **Deleting** — a trash icon button appears on hover, focus, or always on touch devices. Press once to arm (`Press again to delete`, turns red, auto-disarms after 3 s), press again to confirm. Escape disarms. Nothing is lost to a stray click.
- **Header** — conversation title on the left; on the right the live state: `contacting model… 2s` → `typesetting… 9s` → `writing… 14s` → `34.2s · ~200 tok in`. A 2 px indeterminate progress line runs under the header while a request is in flight.
- **Draft column** — word and approximate token count in the column header. Focus is shown by an inset coral hairline around the column and a coral label, so the input area is legible without a heavy outline.
- **Rewrite column** — a faint coral margin rule runs down the left edge, evoking a marked-up page. Text streams in token by token behind a blinking caret and is replaced wholesale by the authoritative `done` payload. The column header shows how many passes it took.
- **Margin notes** — warnings are editorial margin notes (2 px rule + small-caps label), not generic alert boxes: coral `CONTAMINATION` when a response carries text from another draft, amber `VERIFY` for numbers that disappeared, amber `CHECK LENGTH` for an over-long response, coral `ERROR` for failures, neutral `NOTE` for resamples. A standing warning is never overwritten by another notice.
- **Empty state** — a proofreader's caret mark, one line of guidance, and a `Try an example` button that loads a real AI-flavoured draft (with numbers in it, so the verification path is easy to see).
- **Footer** — keyboard hint on the left; `Copy` and `Humanize` on the right, both in the same row so they align with the draft column's controls.

Keyboard: `Ctrl/Cmd + Enter` humanizes from the textarea. Escape closes the drawer or disarms a pending delete.

**Copy button.** Tries the Clipboard API first (secure contexts only), falls back to the legacy `execCommand("copy")` path so it also works over plain HTTP on a LAN address, and if both are blocked it selects the rewrite in place and tells you to press Ctrl/Cmd+C. The button itself flashes `Copied` or `Selected` — results warnings are never overwritten.

**Responsive.** At 1280 px and above: 264 px sidebar, equal columns, 66-character measure. Below 1280 px: 224 px sidebar and the rewrite column gets the larger share (0.9 / 1.1). Below 900 px: the sidebar becomes an off-canvas drawer behind a menu button (scrim, Escape, focus moved in and trapped), the columns stack 45/55, and the action bar becomes a sticky bottom bar. Below 560 px: the keyboard hint hides and the primary button takes the full width.

## Design system

Defined once as CSS custom properties at the top of `web/style.css`.

| Group | Tokens |
|---|---|
| Surfaces | `--ink-1000` page `#0b0a09`, `--ink-950` chrome `#100e0d`, `--ink-900` result `#141211`, `--ink-800` hover `#1b1917`, `--line` / `--line-soft` / `--line-strong` |
| Text | `--text` `#f4f1ec` (16:1), `--text-muted` `#a8a29a` (7.5:1), `--text-faint` `#857f77` (4.7:1 — passes AA at small sizes) |
| Semantics | `--accent` coral `#ff7a5c` = act, `--caution` amber `#f2b134` = verify, `--ready` sage `#7fbf9b` = good, `--danger` `#e5484d` = errors only |
| Type | `--font-sans` system UI for chrome, `--font-serif` (Charter/Georgia) for the draft and rewrite at 18 px/1.72, `--font-mono` for counts, timings and ids |
| Space | 4 px base: `--s1` … `--s7` (`4 8 12 16 24 32 48`) |
| Motion | `--t-fast` 120 ms, `--t-med` 180 ms, `--t-slow` 240 ms, `--ease` `cubic-bezier(.2,.7,.3,1)` |

The only gradient is one quiet coral wash behind the top-right of the page; the only texture is a 2% paper grain. Icons are inline SVG at 1.6–1.8 stroke in `currentColor` — no icon font, no emoji, no external requests of any kind. Every interactive element has a visible `:focus-visible` ring, and all animation is disabled under `prefers-reduced-motion: reduce`.


## Configuration

Environment variables read by `run.sh`:

| Variable | Default | Purpose |
|---|---|---|
| `MODEL` | the cached `humanizer-12b-IQ2_XS-QAT.gguf` | path to a different GGUF |
| `NGL` | `38` | layers offloaded to the GPU |
| `CTX` | `8192` | context size (the model card requires 8192) |
| `LLAMA_PORT` | `8080` | llama.cpp port |
| `APP_PORT` | `8090` | web server port |

Example: `NGL=0 ./run.sh` runs purely on CPU.

Flags of the Go binary (`bin/humanize`), useful if you start it yourself:

```
-addr   :8090        listen address
-llama  http://127.0.0.1:8080
-web    web          static files directory
```

## Performance

The GPU offload level was benchmarked on a fixed draft with `-c 8192 -np 1`:

| `-ngl` | prompt tokens/s | generation tokens/s | VRAM |
|---|---|---|---|
| 20 | 5.4 | 3.9 | 2356 MiB |
| 30 | 16.0 | 7.4 | 2928 MiB |
| 35 | 20.4 | 8.1 | 3359 MiB |
| **38 (default)** | **24.2** | **8.1** | **3610 MiB** |
| 39 | 26.0 | 8.1 | 3686 MiB |
| 40 | fails to load (CUDA out of memory) | | |

38 is the practical ceiling: it keeps about 486 MiB of VRAM free for the desktop and the browser, and generation speed no longer improves past 35. Compared with the original settings this is 4.8x faster prompt processing and 2.1x faster generation.

In practice a 150-word paragraph takes roughly 20 to 40 seconds. Streaming exists precisely so you can read while it writes.

## Testing

```bash
./run.sh                    # must be running
./scripts/selftest.sh       # end-to-end against the model's own checklist
go test ./server            # prompt contract + contamination guard unit tests
python3 scripts/soak.py     # contamination soak (3 marker runs, ~1 min)
python3 scripts/uitest.py   # browser suite via obscura (see below)
```

The self-test is a port of section 8 of the model's `AGENTS.md`. It checks the health endpoints, confirms the prompt-hash log line, sends a real draft from the model's evaluation set through the streaming API, and then validates the result:

- a `done` event arrived
- the output is not suspiciously short
- no prompt echo and no chat markers
- the output does not copy the draft (5-gram overlap under 50%)
- the streamed tokens concatenate to exactly the final text
- the server's missing-number report agrees with an independent recount

Expected final line: `PASS: install looks right`.

**Contamination soak** (`scripts/soak.py`) runs three drafts with distinctive marker terms back to back and fails if any response contains another run's markers, if an overrun goes unflagged, or if the guard ever fires on a clean run.

**Browser suite** (`scripts/uitest.py`) drives the real UI through obscura's MCP server: it loads the page, asserts zero external requests and zero console errors, checks the focus-visible and reduced-motion rules, runs a full streaming rewrite, exercises the copy button, the two-step delete, Escape, the New-reset, and the drawer logic. It expects obscura's MCP endpoint:

```bash
./obscura mcp --http --port 8399 --allow-private-network &
python3 scripts/uitest.py
```

Known limits of the test engine (all verified, none are app bugs): obscura cannot resolve `ch` units or change the viewport, does not paint CSS gradients, and does not apply `:focus`/`:focus-visible` — so measure, gradient and focus checks assert the stylesheet declarations instead of computed styles. Screenshots from `./obscura fetch … -s file.png` are faithful for layout, colour and typography.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `port 8080 is in use` | a previous run left something behind | `./run.sh stop`, or set `LLAMA_PORT` |
| `llama-server not found` | llama.cpp not on PATH | `brew install llama.cpp` |
| `model not found` | `MODEL` points somewhere wrong | export the correct `MODEL` path |
| Sidebar says "model offline" | llama.cpp died | `./run.sh status`, check `logs/llama.log` |
| Very slow, GPU idle | no layers on the GPU | check `NGL` and `logs/llama.log` |
| Rewrite contains unrelated text | cross-request context bleed (now disabled) or a bad run | check `logs/prompts.log` for the exact prompt; the UI flags it as CONTAMINATION |
| Rewrite in Chinese for English text | a known model quirk | the server retries automatically; re-run if it persists |
| Numbers changed | a known weakness of the 2-bit file | the warning strip lists them; proofread before sending |
| History vanished | the store is in-memory by design | nothing to fix |

## Design decisions and limits

- **In-memory only.** Conversations live in a Go map guarded by a mutex. Restarting clears them. That was the requirement, and it also keeps the app trivially safe to run offline.
- **One draft per request.** The 8192-token context holds the instruction, one draft, and its rewrite. Long documents need splitting; the model's own `hz` tool does that, and it is out of scope here.
- **No silent edits.** If a number or a fact goes missing, the app reports it rather than patching the output.
- **Clicking a conversation loads its latest rewrite.** Each Humanize press inside an existing conversation appends another message to that session; `New` starts a fresh one.
- **Quality expectations for the 2-bit file.** Upstream measurements: 70 of 420 English rewrites flagged by a strict fact judge, but 0 of 60 flagged as AI-generated by a detector. Proofread numbers, dates and names regardless.
- **SSE parsing is manual.** `EventSource` cannot POST, so `app.js` reads the fetch response body and splits on blank lines.

## Credits

- Model: [jialinyyzz/humanizer](https://huggingface.co/jialinyyzz/humanizer), Apache-2.0, fine-tuned from `google/gemma-4-12B`. Documentation and the self-test this project borrows come from its `AGENTS.md` and model card.
- Runtime: [llama.cpp](https://github.com/ggml-org/llama.cpp).
- Everything else in this repository is written for this project: Go standard library, plain HTML, CSS and JavaScript.
