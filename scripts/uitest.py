#!/usr/bin/env python3
"""Interactive UI test for Humanizer, driven through obscura's MCP server."""
import json, sys, time, urllib.request

MCP = "http://127.0.0.1:8399/mcp"
BASE = "http://127.0.0.1:8090"
SHOTS = "/tmp/opencode/shots"
_results = []


def call(name, args=None, timeout=300):
    body = json.dumps({"jsonrpc": "2.0", "id": int(time.time() * 1000) % 100000,
                       "method": "tools/call", "params": {"name": name, "arguments": args or {}}}).encode()
    req = urllib.request.Request(MCP, data=body, method="POST",
        headers={"Content-Type": "application/json", "Accept": "application/json, text/event-stream"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        resp = json.load(r)
    if "error" in resp:
        raise RuntimeError(f"{name}: {resp['error']}")
    res = resp.get("result", {})
    if res.get("isError"):
        raise RuntimeError(f"{name} failed: {res.get('content')}")
    texts = [c.get("text", "") for c in res.get("content", []) if c.get("type") == "text"]
    return "\n".join(texts)


def ev(expr, timeout=10000):
    out = call("browser_evaluate", {"expression": expr, "timeoutMs": timeout})
    try:
        return json.loads(out)
    except (ValueError, TypeError):
        return out


def check(label, ok, detail=""):
    _results.append((label, bool(ok), detail))
    print(("PASS  " if ok else "FAIL  ") + label + (f"  [{detail}]" if detail else ""))
    return bool(ok)


def wait_for(expr, timeout=240000, poll=200):
    deadline = time.time() + timeout / 1000
    while time.time() < deadline:
        try:
            if ev(expr, 15000):
                return True
        except Exception:
            time.sleep(poll / 1000)
        time.sleep(poll / 1000)
    return False


# ---------------------------------------------------------------- load
print("== load ==")
call("browser_navigate", {"url": BASE + "/", "waitUntil": "load"})
time.sleep(1.0)

state = ev("""(() => ({
  w: innerWidth, h: innerHeight,
  drawerMode: matchMedia('(max-width: 899px)').matches,
  menu: getComputedStyle(document.getElementById('menuBtn')).display,
  close: getComputedStyle(document.getElementById('drawerClose')).display,
  empty: !!document.querySelector('.empty'),
  example: !!document.getElementById('exampleBtn'),
  copyHidden: document.getElementById('copyBtn').hidden,
  focusRule: [...document.styleSheets].some(s => {
    try { return [...s.cssRules].some(r => (r.selectorText||'').includes(':focus-visible')); }
    catch (e) { return false; }
  }),
  reducedMotion: [...document.styleSheets].some(s => {
    try { return [...s.cssRules].some(r => (r.conditionText||'').includes('prefers-reduced-motion')); }
    catch (e) { return false; }
  }),
  status: document.getElementById('statusText').textContent,
  emoji: /[\\u{1F300}-\\u{1FAFF}\\u{2600}-\\u{27BF}]/u.test(document.body.innerText),
  ext: performance.getEntriesByType('resource').map(r => r.name).filter(n => !n.startsWith(location.origin))
}))()""")
check("page loaded with empty state + example button",
      state.get("empty") and state.get("example"))
check("menu/close buttons hidden on desktop", state.get("menu") == "none" and state.get("close") == "none")
check("copy button hidden before a run", state.get("copyHidden") is True)
check(":focus-visible rule present", state.get("focusRule") is True)
check("prefers-reduced-motion block present", state.get("reducedMotion") is True)
check("no emoji anywhere in the page", state.get("emoji") is False, str(state.get("emoji")))
check("zero external resource requests", not state.get("ext"), str(state.get("ext")))
check("model status ready", state.get("status") == "model ready", str(state.get("status")))

# ---------------------------------------------------------------- example draft
print("== example draft ==")
call("browser_click", {"selector": "#exampleBtn"})
filled = ev("({v: document.getElementById('draft').value.length, meta: document.getElementById('draftMeta').textContent})")
check("example draft inserted with stats", filled["v"] > 200 and "words" in filled["meta"], filled["meta"])

# ---------------------------------------------------------------- humanize (streaming run)
print("== run ==")
call("browser_click", {"selector": "#humanizeBtn"})
started = time.time()
saw_live = wait_for("!!document.getElementById('progress') && !document.getElementById('progress').hidden", 15000)
check("progress line appears while working", saw_live)
meta_mid = ev("document.getElementById('runMeta').textContent")
check("live run meta during the blind wait", bool(meta_mid), meta_mid)

done = wait_for(
    "/s · ~\\d+ tok in/.test(document.getElementById('runMeta').textContent) || "
    "document.getElementById('runMeta').textContent === 'failed'", 240000)
elapsed = time.time() - started
runstate = ev("""(() => ({
  meta: document.getElementById('runMeta').textContent,
  result: document.getElementById('result').textContent,
  copyHidden: document.getElementById('copyBtn').hidden,
  outMeta: document.getElementById('outMeta').textContent,
  noticeHidden: document.getElementById('notice').hidden,
  caret: !!document.querySelector('.caret'),
  btn: document.getElementById('humanizeBtn').textContent,
  btnDisabled: document.getElementById('humanizeBtn').disabled,
  progressHidden: document.getElementById('progress').hidden,
  title: document.getElementById('convoTitle').textContent,
  sr: document.querySelector('.sr-only[aria-live]').textContent,
  items: document.querySelectorAll('.item').length,
  metaLen: getComputedStyle(document.getElementById('result')).maxWidth
}))()""")
check("run finished", done and not runstate["meta"] in ("failed", "no output"), runstate["meta"])
check("streamed text present", len(runstate["result"]) > 100, f"{len(runstate['result'])} chars in {elapsed:.0f}s")
check("copy button revealed", runstate["copyHidden"] is False)
check("streaming caret removed at the end", runstate["caret"] is False)
check("pass count shown", "pass" in runstate["outMeta"], runstate["outMeta"])
check("no spurious warning on a clean run", runstate["noticeHidden"] is True)
check("button re-enabled with original label",
      runstate["btn"] == "Humanize" and runstate["btnDisabled"] is False)
check("progress line hidden again", runstate["progressHidden"] is True)
check("conversation title set", runstate["title"] != "New rewrite", runstate["title"])
check("screen reader announced completion", "finished" in runstate["sr"], runstate["sr"])
check("history gained an item", runstate["items"] >= 1, str(runstate["items"]))

# obscura's CSS engine drops `ch` units (an inline max-width:66ch computes to
# none as well), so verify the declaration in the stylesheet instead of computed.
measure = ev("""(() => {
  const rule = sel => {
    for (const s of document.styleSheets) {
      try { for (const r of s.cssRules) if ((r.selectorText||'') === sel) return r.style.maxWidth; }
      catch (e) {}
    }
    return null;
  };
  return { result: rule('.result'), ta: rule('textarea'),
           measure: getComputedStyle(document.documentElement).getPropertyValue('--measure') };
})()""")
check("66ch measure declared on result and textarea",
      measure["result"] == "var(--measure)" and measure["ta"] == "var(--measure)"
      and measure["measure"].strip() == "66ch", str(measure))

# ---------------------------------------------------------------- copy button
print("== copy ==")
clip = ev("({secure: window.isSecureContext === true, hasClipboard: !!(navigator.clipboard && navigator.clipboard.writeText)})")
call("browser_click", {"selector": "#copyBtn"})
time.sleep(1.2)
after = ev("""({label: document.getElementById('copyBtn').querySelector('.btn-label').textContent,
                 success: document.getElementById('copyBtn').classList.contains('is-success'),
                 notice: document.getElementById('notice').hidden})""")
check("copy gives visible feedback (no silent failure)",
      after["label"] in ("Copied", "Selected") and after["success"],
      f"secure={clip.get('secure')} clipboardAPI={clip.get('hasClipboard')} label={after['label']}")

# ---------------------------------------------------------------- two-step delete
print("== delete ==")
before = ev("document.querySelectorAll('.item').length")
call("browser_click", {"selector": ".item .item-del"})
armed = ev("({armed: !!document.querySelector('.item.is-armed'), meta: (document.querySelector('.item.is-armed .item-meta')||{}).textContent})")
check("first press arms the delete", armed["armed"] and "again" in (armed["meta"] or ""), str(armed["meta"]))
call("browser_click", {"selector": ".item.is-armed .item-del"})
time.sleep(0.8)
after_n = ev("document.querySelectorAll('.item').length")
check("second press deletes", after_n == before - 1, f"{before} -> {after_n}")

# Escape disarms a pending delete
call("browser_click", {"selector": ".item .item-del"})
call("browser_press_key", {"key": "Escape"})
dis = ev("({armed: !!document.querySelector('.item.is-armed'), any: document.querySelectorAll('.item.is-armed').length})")
check("Escape disarms", dis["armed"] is False)

# ---------------------------------------------------------------- new rewrite resets
print("== new ==")
call("browser_click", {"selector": "#newBtn"})
reset = ev("""({draft: document.getElementById('draft').value,
                 empty: !!document.querySelector('.empty'),
                 copyHidden: document.getElementById('copyBtn').hidden,
                 title: document.getElementById('convoTitle').textContent,
                 notice: document.getElementById('notice').hidden})""")
check("New rewrite resets every panel",
      reset["draft"] == "" and reset["empty"] and reset["copyHidden"]
      and reset["title"] == "New rewrite" and reset["notice"])

# ---------------------------------------------------------------- keyboard focus
print("== keyboard ==")
focus = ev("(() => { document.getElementById('draft').focus(); return document.activeElement.id; })()")
check("textarea focusable", focus == "draft", focus)

# obscura does not apply :focus / :focus-visible rules at all (an injected
# #el:focus{outline:3px solid red} computes to '' too), and synthetic Tab does
# not move focus — so verify the declaration itself, which real browsers apply.
focusrules = ev("""(() => {
  for (const s of document.styleSheets) {
    try {
      for (const r of s.cssRules) {
        if ((r.selectorText || '') === ':focus-visible') return { css: r.style.cssText };
      }
    } catch (e) {}
  }
  return null;
})()""")
css = (focusrules or {}).get("css", "")
check(":focus-visible declares a 2px accent ring with offset",
      "outline: 2px solid var(--accent)" in css and "outline-offset: 2px" in css, css)

# ---------------------------------------------------------------- screenshots
print("== screenshots ==")
call("browser_screenshot", {"width": 1440, "height": 900})
call("browser_evaluate", {"expression": "1"})
shot_dims = ev("({w: innerWidth, drawer: matchMedia('(max-width: 899px)').matches})")
print(f"   viewport after sized capture: {shot_dims}")

# ---------------------------------------------------------------- responsive / drawer
print("== responsive ==")
# obscura's capture size does not change the viewport (innerWidth stays 1280),
# so exercise the drawer's JS path directly and assert its CSS contract.
drawer_css = ev("""(() => {
  let media = null;
  for (const s of document.styleSheets) {
    try { for (const r of s.cssRules) if ((r.conditionText || '').includes('899px')) media = r; } catch (e) {}
  }
  if (!media) return null;
  const find = sel => { for (const r of media.cssRules) if ((r.selectorText || '') === sel) return r.style.cssText; };
  return { sidebar: find('.sidebar'), open: find('.sidebar.is-open'),
           cols: find('.columns'), stacked: !!find('.col--out') };
})()""")
check("mobile CSS: sidebar becomes a fixed off-canvas drawer",
      drawer_css and 'position: fixed' in drawer_css["sidebar"]
      and 'transform: translateX(-101%)' in drawer_css["sidebar"]
      and 'transform: none' in drawer_css["open"], str(drawer_css))
check("mobile CSS: columns stack to a single column",
      drawer_css and 'grid-template-columns: 1fr' in drawer_css["cols"], str(drawer_css.get("cols")))

call("browser_evaluate", {"expression": "openDrawer(), 1"})
time.sleep(0.4)
drawer = ev("""({open: document.getElementById('sidebar').classList.contains('is-open'),
                 expanded: document.getElementById('menuBtn').getAttribute('aria-expanded'),
                 scrim: !document.getElementById('scrim').hidden,
                 focusInSidebar: document.getElementById('sidebar').contains(document.activeElement)})""")
check("drawer opens: class + aria-expanded + scrim + focus moved in",
      drawer["open"] and drawer["expanded"] == "true" and drawer["scrim"] and drawer["focusInSidebar"],
      str(drawer))
ev("document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))")
time.sleep(0.3)
closed = ev("({open: document.getElementById('sidebar').classList.contains('is-open'), scrim: document.getElementById('scrim').hidden, expanded: document.getElementById('menuBtn').getAttribute('aria-expanded')})")
check("Escape closes the drawer",
      closed["open"] is False and closed["scrim"] is True and closed["expanded"] == "false", str(closed))
call("browser_screenshot", {"width": 375, "height": 812})

# ---------------------------------------------------------------- console & network
print("== console/network ==")
msgs = call("browser_console_messages")
try:
    parsed = [json.loads(l) for l in msgs.splitlines() if l.strip().startswith("{")]
except ValueError:
    parsed = []
errors = [m for m in parsed if "error" in str(m.get("level", m.get("type", ""))).lower()]
check("no console errors during the whole session", not errors, json.dumps(errors)[:300])

reqs = call("browser_network_requests")
ext = [l for l in reqs.splitlines() if l.strip() and BASE not in l]
check("every network request is same-origin", not ext, str(ext)[:300])

# ---------------------------------------------------------------- summary
print("\n== summary ==")
fails = [r for r in _results if not r[1]]
print(f"{len(_results) - len(fails)}/{len(_results)} checks passed")
for label, ok, detail in fails:
    print(f"  FAILED: {label} [{detail}]")
sys.exit(1 if fails else 0)
