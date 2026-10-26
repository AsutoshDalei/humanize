#!/usr/bin/env python3
"""Contamination soak: run distinct marker drafts back to back through the real
API and fail if any response contains content from another run."""
import json, sys, urllib.request

URL = "http://127.0.0.1:8090/api/humanize"

DRAFTS = [
    ("A", "The ZQXJ7 velocimeter report shows 812 units were shipped to Ostrava "
          "before the quorum adjourned, leaving forty-four unaccounted crates in "
          "the north vestibule under Marcus's supervision."),
    ("B", "Brenda's K49 frost survey describes twelve terraced orchards above the "
          "Kellerman ridge where an early freeze delayed the second harvest by "
          "nine days and ruined the planned cider pressing."),
    ("C", "The harbour authority confirmed that Pier 6 reopened on Tuesday after "
          "divers cleared the sunken barge, restoring berths for seventeen "
          "fishing vessels ahead of the weekend storm."),
]
# tokens that must never appear outside their own run
MARKERS = {"A": ["ZQXJ7", "velocimeter", "Ostrava", "quorum adjourned"],
           "B": ["K49", "Kellerman", "cider pressing", "Brenda"],
           "C": ["Pier 6", "sunken barge", "harbour authority"]}


def run(tag, draft):
    req = urllib.request.Request(URL, method="POST",
        data=json.dumps({"draft": draft}).encode(),
        headers={"Content-Type": "application/json"})
    done, events, contaminated = None, [], ""
    with urllib.request.urlopen(req, timeout=600) as r:
        block, buf = "", b""
        # read SSE: blocks separated by blank lines
        while True:
            chunk = r.read(4096)
            if not chunk:
                break
            buf += chunk
            while b"\n\n" in buf:
                block, buf = buf.split(b"\n\n", 1)
                text = block.decode("utf-8", "replace")
                ev, data = "message", ""
                for line in text.splitlines():
                    if line.startswith("event:"):
                        ev = line[6:].strip()
                    elif line.startswith("data:"):
                        data += line[5:].strip()
                if not data:
                    continue
                try:
                    d = json.loads(data)
                except ValueError:
                    continue
                events.append(ev)
                if ev == "done":
                    done = d
                    contaminated = d.get("contamination", "")
                    if d.get("overrun"):
                        contaminated += " [overrun flag set]"
    if done is None:
        raise SystemExit(f"{tag}: no done event (events: {events})")
    return done, contaminated


fails = []
for tag, draft in DRAFTS:
    done, flag = run(tag, draft)
    out = done["text"]
    print(f"--- run {tag}: {done['ms']/1000:.1f}s, {len(out)} chars out, "
          f"contam={flag or 'none'}, missing={done['missingNumbers']}")
    for t in sum((MARKERS[k] for k in MARKERS if k != tag), []):
        if t.lower() in out.lower():
            fails.append(f"run {tag} leaked another run's marker: {t!r}")
    # appended-block heuristic: the response should not dwarf the draft
    if len(out) > 2 * len(draft) + 400 and not flag:
        fails.append(f"run {tag} overran the draft but no flag was set")
    if flag:
        fails.append(f"run {tag} reported contamination: {flag}")

if fails:
    print("\nFAIL")
    for f in fails:
        print("  " + f)
    sys.exit(1)
print("\nPASS: no cross-run contamination across", len(DRAFTS), "runs")
