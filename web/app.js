/* Humanizer front end — vanilla JS, no dependencies.
   The server streams the rewrite as SSE over a POST response body, so the
   event stream is parsed by hand (EventSource cannot POST). */

"use strict";

const $ = (id) => document.getElementById(id);

const ICON = {
  caret: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M7 14.5 12 7l5 7.5"/><path d="M5 18.5h14" opacity=".45"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 6h17M8.5 6V4.6A1.6 1.6 0 0 1 10.1 3h3.8a1.6 1.6 0 0 1 1.6 1.6V6M18.5 6l-.9 13.1a1.9 1.9 0 0 1-1.9 1.8H8.3a1.9 1.9 0 0 1-1.9-1.8L5.5 6"/></svg>',
};

/* ---------- elements ---------- */

const sidebar = $("sidebar");
const scrim = $("scrim");
const menuBtn = $("menuBtn");
const drawerClose = $("drawerClose");
const newBtn = $("newBtn");
const historyList = $("historyList");
const statusEl = $("status");
const statusText = $("statusText");
const convoTitle = $("convoTitle");
const runMeta = $("runMeta");
const progress = $("progress");
const draftMeta = $("draftMeta");
const outMeta = $("outMeta");
const draftEl = $("draft");
const noticeEl = $("notice");
const resultEl = $("result");
const hintEl = $("hint");
const copyBtn = $("copyBtn");
const humanizeBtn = $("humanizeBtn");

// polite announcements that must not disturb the visible layout
const srLive = document.createElement("div");
srLive.className = "sr-only";
srLive.setAttribute("aria-live", "polite");
document.body.appendChild(srLive);

let currentSessionId = null;
let lastResult = "";
let busy = false;

const EXAMPLE_DRAFT =
  "Artificial intelligence has revolutionized the way modern organizations approach " +
  "decision-making, leveraging cutting-edge algorithms to optimize processes and enhance " +
  "operational efficiency across the globe. In today's rapidly evolving marketplace, " +
  "businesses that fail to adopt these transformative technologies risk losing their " +
  "competitive advantage. Our Q3 report demonstrates a 42% improvement in throughput since " +
  "implementation, and the data clearly shows that these innovative solutions are " +
  "instrumental in driving sustainable growth moving forward.";

/* ---------- small helpers ---------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

function showNoteText(kind, label, text) {
  noticeEl.className = "note note--" + kind;
  noticeEl.innerHTML =
    '<span class="note-label"></span><p class="note-text"></p>';
  noticeEl.querySelector(".note-label").textContent = label;
  noticeEl.querySelector(".note-text").textContent = text;
  noticeEl.hidden = false;
}

function showNoteHTML(kind, label, html) {
  noticeEl.className = "note note--" + kind;
  noticeEl.innerHTML =
    '<span class="note-label"></span><p class="note-text"></p>';
  noticeEl.querySelector(".note-label").textContent = label;
  noticeEl.querySelector(".note-text").innerHTML = html;
  noticeEl.hidden = false;
}

function hideNote() { noticeEl.hidden = true; }

function announce(text) { srLive.textContent = text; }

function titleFor(draft) {
  const t = String(draft).replace(/\s+/g, " ").trim();
  const r = [...t];
  return r.length > 60 ? r.slice(0, 60).join("") + "…" : t;
}

/* ---------- result panel ---------- */

function renderEmptyOutput() {
  resultEl.innerHTML =
    '<div class="empty">' +
      '<span class="empty-mark">' + ICON.caret + "</span>" +
      '<p class="empty-title">Nothing rewritten yet</p>' +
      '<p class="empty-text">Press Humanize and the rewrite streams into this panel, sentence by sentence.</p>' +
      '<button class="btn btn-ghost btn-sm" id="exampleBtn" type="button">Try an example</button>' +
    "</div>";
  const b = $("exampleBtn");
  if (b) b.addEventListener("click", insertExample);
}

function clearOutput() { resultEl.innerHTML = ""; lastResult = ""; }

function insertExample() {
  if (busy) return;
  draftEl.value = EXAMPLE_DRAFT;
  updateDraftStats();
  hideNote();
  draftEl.focus();
  draftEl.setSelectionRange(0, 0);
  draftEl.scrollTop = 0;
}

function setResult(text) {
  resultEl.textContent = text;
  lastResult = text;
  copyBtn.hidden = !text;
}

function appendToken(t) {
  resultEl.appendChild(document.createTextNode(t));
  const caret = ensureCaret();
  resultEl.appendChild(caret);
  resultEl.scrollTop = resultEl.scrollHeight;
}

function ensureCaret() {
  let c = resultEl.querySelector(".caret");
  if (!c) {
    c = document.createElement("span");
    c.className = "caret";
  }
  return c;
}

function removeCaret() {
  const c = resultEl.querySelector(".caret");
  if (c) c.remove();
}

/* ---------- run state (top bar) ---------- */

let runTimer = null;
let runStart = 0;
let sawToken = false;

function beginRun() {
  runStart = Date.now();
  sawToken = false;
  runMeta.classList.add("is-live");
  runMeta.textContent = "contacting model…";
  progress.hidden = false;
  clearInterval(runTimer);
  runTimer = setInterval(() => {
    const secs = ((Date.now() - runStart) / 1000).toFixed(0);
    runMeta.textContent = (sawToken ? "writing…" : "typesetting…") + " " + secs + "s";
  }, 400);
}

function endRun(label) {
  clearInterval(runTimer);
  runTimer = null;
  progress.hidden = true;
  runMeta.classList.remove("is-live");
  runMeta.textContent = label || "";
}

/* ---------- notices for a finished pair ---------- */

function showPairNotice(m) {
  if (m.contamination) {
    showNoteHTML(
      "error",
      "Contamination",
      "This response contains a verbatim run from a different draft — " +
        "<code>" + esc(String(m.contamination).slice(0, 90)) + "</code>. " +
        "It was not derived from your text, so re-run the rewrite. " +
        "The exact request is recorded in <code>logs/prompts.log</code>."
    );
    return;
  }
  if (m.missingNumbers && m.missingNumbers.length) {
    const nums = m.missingNumbers.map((n) => "<code>" + esc(n) + "</code>").join(", ");
    const retry = m.retries
      ? "<br>" + m.retries + " resample" + (m.retries > 1 ? "s" : "") + " (language check)."
      : "";
    showNoteHTML(
      "caution",
      "Verify",
      "These numbers are in your draft but not in the rewrite — " + nums + "." + retry
    );
  } else if (m.overrun) {
    showNoteText(
      "caution",
      "Check length",
      "The response came back much longer than your draft — part of it may be unrelated text. Compare it against your draft before using it."
    );
  } else if (m.retries) {
    showNoteText("info", "Note", "Resampled " + m.retries + "× — the first attempt came back in the wrong language.");
  } else {
    hideNote();
  }
}

/* ---------- timestamps ---------- */

function relTime(iso) {
  const norm = String(iso).replace(/(\.\d{3})\d+/, "$1");
  const t = Date.parse(norm);
  if (isNaN(t)) return "";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  if (s < 604800) return Math.floor(s / 86400) + "d ago";
  return new Date(t).toLocaleDateString();
}

/* ---------- sessions ---------- */

async function loadSessions() {
  try {
    const r = await fetch("/api/sessions");
    const d = await r.json();
    renderSessions(d.sessions || []);
    if (currentSessionId) {
      const cur = (d.sessions || []).find((s) => s.id === currentSessionId);
      if (cur) convoTitle.textContent = cur.title;
    }
  } catch (e) {
    historyList.innerHTML =
      '<li class="history-empty">Cannot reach the server. Try ./run.sh status.</li>';
  }
}

function renderSessions(list) {
  disarmDelete();
  historyList.innerHTML = "";

  if (!list.length) {
    historyList.innerHTML =
      '<li class="history-empty"><span class="mark">' + ICON.caret + "</span>" +
      "No rewrites yet. Paste a draft and press Humanize — every run is saved here.</li>";
    return;
  }

  for (const s of list) {
    const li = document.createElement("li");
    li.className = "item" + (s.id === currentSessionId ? " is-active" : "");
    li.dataset.id = s.id;

    const open = document.createElement("button");
    open.type = "button";
    open.className = "item-open";
    open.innerHTML =
      '<span class="item-title"></span><span class="item-meta"></span>';
    open.querySelector(".item-title").textContent = s.title;
    open.querySelector(".item-meta").textContent =
      relTime(s.updatedAt) + " · " + s.count + (s.count === 1 ? " rewrite" : " rewrites");
    open.addEventListener("click", () => openSession(s.id));

    const del = document.createElement("button");
    del.type = "button";
    del.className = "item-del";
    del.innerHTML = ICON.trash;
    del.setAttribute("aria-label", "Delete conversation: " + s.title);
    del.addEventListener("click", () => armOrDelete(s.id, li, open.querySelector(".item-meta")));

    li.append(open, del);
    historyList.appendChild(li);
  }
}

/* two-step delete: the first press arms, the second one commits */
let armedId = null;
let armTimer = null;

function armOrDelete(id, li, metaEl) {
  if (armedId !== id) {
    disarmDelete();
    armedId = id;
    li.classList.add("is-armed");
    metaEl.dataset.orig = metaEl.textContent;
    metaEl.textContent = "Press again to delete";
    armTimer = setTimeout(disarmDelete, 3000);
  } else {
    deleteSession(id);
  }
}

function disarmDelete() {
  clearTimeout(armTimer);
  armTimer = null;
  if (!armedId) return;
  const li = historyList.querySelector(".item.is-armed");
  if (li) {
    li.classList.remove("is-armed");
    const meta = li.querySelector(".item-meta");
    if (meta && meta.dataset.orig) meta.textContent = meta.dataset.orig;
  }
  armedId = null;
}

async function deleteSession(id) {
  disarmDelete();
  await fetch("/api/sessions/" + encodeURIComponent(id), { method: "DELETE" });
  if (currentSessionId === id) {
    currentSessionId = null;
    resetPanels();
  }
  announce("Conversation deleted");
  loadSessions();
}

async function openSession(id) {
  if (busy) return;
  try {
    const r = await fetch("/api/sessions/" + encodeURIComponent(id));
    if (!r.ok) return;
    const s = await r.json();
    currentSessionId = s.id;
    convoTitle.textContent = s.title;
    const m = (s.messages || [])[s.messages.length - 1];
    if (m) {
      draftEl.value = m.draft;
      updateDraftStats();
      setResult(m.result);
      showPairNotice(m);
      outMeta.textContent = (m.retries + 1) + (m.retries ? " passes" : " pass");
      endRun((m.ms / 1000).toFixed(1) + "s · ~" + wordTokens(m.result) + " tok out");
    } else {
      clearOutput();
      renderEmptyOutput();
      hideNote();
      outMeta.textContent = "";
      endRun("");
      copyBtn.hidden = true;
    }
    renderHistoryActive();
    closeDrawer();
  } catch (e) { /* ignore */ }
}

function wordTokens(text) { return Math.round(String(text).length / 3.5); }

function renderHistoryActive() {
  for (const li of historyList.querySelectorAll(".item")) {
    li.classList.toggle("is-active", li.dataset.id === currentSessionId);
  }
}

function resetPanels() {
  draftEl.value = "";
  updateDraftStats();
  renderEmptyOutput();
  hideNote();
  outMeta.textContent = "";
  endRun("");
  copyBtn.hidden = true;
  convoTitle.textContent = "New rewrite";
  renderHistoryActive();
  draftEl.focus();
}

/* ---------- status ---------- */

function setStatus(state, text) {
  statusEl.className = "status" + (state ? " is-" + state : "");
  statusText.textContent = text;
}

async function checkHealth() {
  try {
    const r = await fetch("/api/health");
    const d = await r.json();
    if (d.llama === "ok") setStatus("ok", "model ready");
    else setStatus("down", "model offline");
  } catch (e) {
    setStatus("down", "server offline");
  }
}

/* ---------- draft stats ---------- */

function updateDraftStats() {
  const v = draftEl.value;
  const words = v.trim() ? v.trim().split(/\s+/).length : 0;
  draftMeta.textContent = words
    ? words + " words · ~" + Math.round(v.length / 3.5) + " tok"
    : "";
}

function setBusy(on) {
  busy = on;
  humanizeBtn.disabled = on;
  humanizeBtn.textContent = on ? "Rewriting…" : "Humanize";
  hintEl.textContent = on ? "working — you can keep typing" : "Ctrl / ⌘ + Enter";
}

/* ---------- humanize ---------- */

async function humanize() {
  if (busy) return;
  const draft = draftEl.value.trim();
  if (!draft) {
    showNoteText("info", "Note", "Paste some text first — the rewrite appears on the right.");
    draftEl.focus();
    return;
  }

  hideNote();
  clearOutput();
  outMeta.textContent = "";
  lastResult = "";
  if (!currentSessionId) convoTitle.textContent = titleFor(draft);
  setBusy(true);
  beginRun();
  announce("Rewriting — the model is working");

  let res;
  try {
    res = await fetch("/api/humanize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft, sessionId: currentSessionId }),
    });
  } catch (e) {
    endRun("");
    setBusy(false);
    renderEmptyOutput();
    showNoteText("error", "Connection", "Cannot reach the server: " + e.message);
    return;
  }

  if (!res.ok) {
    let msg = "Request failed (" + res.status + ").";
    try { msg = (await res.json()).error || msg; } catch (e) {}
    endRun("failed");
    setBusy(false);
    renderEmptyOutput();
    showNoteText("error", "Error", msg);
    return;
  }

  await readStream(res.body);
  setBusy(false);
  loadSessions();
}

async function readStream(body) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let failed = false;
  let sawAnything = false;

  const handle = (block) => {
    let event = "message";
    let data = "";
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) return;
    let d;
    try { d = JSON.parse(data); } catch (e) { return; }

    switch (event) {
      case "meta":
        currentSessionId = d.sessionId;
        break;

      case "token":
        sawToken = true;
        sawAnything = true;
        appendToken(d.t);
        break;

      case "retry":
        removeCaret();
        clearOutput();
        showNoteText(
          "info", "Retrying",
          "Attempt " + d.attempt + ": the previous attempt came back in Chinese. Resampling…"
        );
        break;

      case "done": {
        removeCaret();
        setResult(d.text);
        currentSessionId = d.sessionId;
        showPairNotice(d);
        outMeta.textContent =
          d.attempts + (d.attempts === 1 ? " pass" : " passes");
        const secs = (d.ms / 1000).toFixed(1);
        endRun(secs + "s · ~" + d.draftTokens + " tok in");
        announce("Rewrite finished in " + secs + " seconds" +
          (d.missingNumbers && d.missingNumbers.length
            ? "; " + d.missingNumbers.length + " number(s) need checking"
            : ""));
        break;
      }

      case "error":
        removeCaret();
        failed = true;
        endRun("failed");
        showNoteText("error", "Error", d.message);
        break;
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        handle(buf.slice(0, i));
        buf = buf.slice(i + 2);
      }
    }
    if (buf.trim()) handle(buf);
  } catch (e) {
    failed = true;
    endRun("interrupted");
    showNoteText("error", "Error", "Stream interrupted: " + e.message);
  }

  removeCaret();
  if (!failed && !sawAnything) {
    endRun("no output");
    renderEmptyOutput();
    showNoteText("error", "Error", "The model returned nothing — try again.");
  } else if (!failed && !lastResult) {
    lastResult = resultEl.textContent;
    copyBtn.hidden = !lastResult;
  }
}

/* ---------- copy ---------- */

copyBtn.addEventListener("click", async () => {
  if (!lastResult) return;
  const how = await copyText(lastResult);
  if (how !== "failed") {
    flashButton(copyBtn, "Copied");
    announce("Rewrite copied to the clipboard");
  } else {
    // Last resort: select the text so Ctrl/Cmd+C always works.
    selectElement(resultEl);
    flashButton(copyBtn, "Selected");
    announce("Clipboard blocked; the rewrite is selected instead");
    // Never replace a standing warning (missing numbers / error) with this.
    const standingWarning =
      !noticeEl.hidden &&
      (noticeEl.classList.contains("note--caution") ||
       noticeEl.classList.contains("note--error"));
    if (!standingWarning) {
      showNoteText(
        "info", "Clipboard",
        "Your browser blocked clipboard access, so the rewrite is selected instead — press Ctrl / ⌘ + C."
      );
    }
  }
});

// navigator.clipboard exists only in a secure context (https or localhost);
// over plain http on a LAN address it is undefined. Fall back to the legacy
// path, then to selecting the text.
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return "clipboard";
    } catch (e) { /* denied or blurred — fall through */ }
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.cssText =
    "position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;" +
    "outline:0;background:transparent;opacity:0;";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try { ta.setSelectionRange(0, text.length); } catch (e) {}
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
  ta.remove();
  return ok ? "legacy" : "failed";
}

function selectElement(el) {
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (e) { /* ignore */ }
}

const flashes = new Map();
function flashButton(btn, label) {
  if (flashes.has(btn)) clearTimeout(flashes.get(btn));
  const target = btn.querySelector(".btn-label") || btn;
  if (!btn.dataset.label) btn.dataset.label = target.textContent;
  target.textContent = label;
  btn.classList.add("is-success");
  flashes.set(btn, setTimeout(() => {
    target.textContent = btn.dataset.label;
    btn.classList.remove("is-success");
    flashes.delete(btn);
  }, 1600));
}

/* ---------- sidebar drawer (mobile) ---------- */

function isDrawer() { return window.matchMedia("(max-width: 899px)").matches; }

function openDrawer() {
  sidebar.classList.add("is-open");
  scrim.hidden = false;
  menuBtn.setAttribute("aria-expanded", "true");
  const first = sidebar.querySelector("button");
  if (first) first.focus();
}

function closeDrawer() {
  if (!sidebar.classList.contains("is-open")) return;
  sidebar.classList.remove("is-open");
  scrim.hidden = true;
  menuBtn.setAttribute("aria-expanded", "false");
  if (isDrawer()) menuBtn.focus();
}

/* ---------- wiring ---------- */

humanizeBtn.addEventListener("click", humanize);
draftEl.addEventListener("input", updateDraftStats);

draftEl.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    humanize();
  }
});

newBtn.addEventListener("click", () => {
  if (busy) return;
  currentSessionId = null;
  resetPanels();
  closeDrawer();
});

menuBtn.addEventListener("click", () => {
  sidebar.classList.contains("is-open") ? closeDrawer() : openDrawer();
});
drawerClose.addEventListener("click", closeDrawer);
scrim.addEventListener("click", closeDrawer);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (armedId) { disarmDelete(); return; }
    closeDrawer();
  }
  // keep Tab inside the drawer while it is open
  if (e.key === "Tab" && sidebar.classList.contains("is-open") && isDrawer()) {
    const f = sidebar.querySelectorAll("button, [href], textarea, input");
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

window.addEventListener("resize", () => {
  if (!isDrawer()) closeDrawer();
});

/* ---------- start ---------- */

renderEmptyOutput();
loadSessions();
checkHealth();
setInterval(checkHealth, 30000);
updateDraftStats();
setStatus("wait", "checking…");
