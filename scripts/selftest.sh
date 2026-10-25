#!/usr/bin/env bash
# Self-test, ported from AGENTS.md §8 of the model repo, run against our API.
# Requires: ./run.sh already started. Standard tools + python3 only.
set -euo pipefail

APP="${APP:-http://127.0.0.1:8090}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# A real draft from the model's evaluation set.
cat >"$WORK/draft.txt" <<'DRAFT'
Hi Nadia,

I'm handing off the Meridian Bank loan audit to you. We've completed the review of 88 files, with 12 files remaining. The outstanding files are in the "Pending Review" folder in the Meridian Bank audit workspace, organized by borrower name.

The remaining items are primarily commercial real estate loans and include several files requiring confirmation of updated income statements, collateral valuations, and covenant documentation. I've flagged the missing items in the audit tracker and added notes for the files that may need follow-up with Meridian Bank's loan operations team.

The deadline is Friday, March 14. Please prioritize the files marked "High" in the tracker, especially MB-2047, MB-2091, and MB-2110, since those are scheduled for management review first. I'll be available through Wednesday afternoon to answer questions or provide context on any earlier decisions.

Thanks for taking this over.
DRAFT

python3 - "$WORK/draft.txt" >"$WORK/payload.json" <<'PY'
import json, sys
print(json.dumps({"draft": open(sys.argv[1], encoding="utf-8").read()}))
PY

echo "1. server health"
HEALTH="$(curl -sf -m 5 "$APP/api/health")" || { echo "   FAIL: app unreachable at $APP — run ./run.sh first"; exit 1; }
echo "   $HEALTH"
case "$HEALTH" in
  *'"llama":"ok"'*) ;;
  *) echo "   FAIL: llama-server not ok"; exit 1 ;;
esac

echo "2. prompt format (verified by the Go server at startup)"
if grep -q "prompt format OK" "$ROOT/logs/app.log" 2>/dev/null; then
  echo "   sha256 prefix cc51d66b4c593fbe verified"
else
  echo "   NOTE: startup line not found in logs/app.log (old log?)"
fi

echo "3. humanize the draft (streaming, may take a minute)"
curl -sN -m 900 -X POST "$APP/api/humanize" \
  -H 'Content-Type: application/json' \
  -d @"$WORK/payload.json" >"$WORK/sse.txt"

echo "4. validating"
python3 - "$WORK/sse.txt" "$WORK/draft.txt" <<'PY'
import json, re, sys

raw = open(sys.argv[1], encoding="utf-8").read()
draft = open(sys.argv[2], encoding="utf-8").read()

events = []
for b in raw.split("\n\n"):
    ev, data = "message", ""
    for line in b.split("\n"):
        if line.startswith("event:"):
            ev = line[6:].strip()
        elif line.startswith("data:"):
            data += line[5:].strip()
    if data:
        try:
            events.append((ev, json.loads(data)))
        except Exception:
            pass

kinds = [e for e, _ in events]
print("   events:", ", ".join(kinds) or "(none)")

if "error" in kinds:
    print("FAIL:", [d for e, d in events if e == "error"])
    sys.exit(1)
if "done" not in kinds:
    print("FAIL: no done event — stream incomplete")
    print(raw[:800])
    sys.exit(1)

done = dict(events)["done"]
out = done["text"].strip()
streamed = "".join(d.get("t", "") for e, d in events if e == "token")

problems = []
if len(out.split()) < 60:
    problems.append("output too short")
if "### Rewritten" in out or out.startswith("Rewrite the text below"):
    problems.append("prompt echoed: wrong endpoint or chat template")
if re.search(r"<start_of_turn>|<end_of_turn>|<\|turn", out):
    problems.append("chat markers in output: a chat template is being applied")

def grams(t):
    w = t.lower().split()
    return {tuple(w[i:i + 5]) for i in range(len(w) - 4)}

gr, go = grams(draft), grams(out)
if gr and go and len(gr & go) / max(1, len(go)) > 0.5:
    problems.append("output copies the draft")

# token stream must match the final text
if streamed.strip() != out:
    problems.append("streamed tokens differ from final text")

missing = [n for n in re.findall(r"\d+", draft) if n not in re.findall(r"\d+", out)]
if missing and list(done.get("missingNumbers") or []) != missing:
    problems.append(f"missing-number report disagrees with our own check: server={done.get('missingNumbers')} ours={missing}")

print(f"   attempts={done.get('attempts')} retries={done.get('retries')} "
      f"{done.get('ms', 0)/1000:.1f}s ~{done.get('draftTokens')} tok in")
print("   " + out[:300].replace("\n", " ") + ("…" if len(out) > 300 else ""))

if problems:
    print("FAIL: " + "; ".join(problems))
    sys.exit(1)
print("PASS: install looks right")
if missing:
    print("NOTE: numbers not in this sample:", ", ".join(missing),
          "(sampling slip — the server reports these in the UI instead of fixing them)")
PY
