/* Humanizer front end — vanilla JS, no dependencies.
   The server streams the rewrite as SSE over a POST response body, so we
   parse the event stream by hand (EventSource cannot POST). */

"use strict";

const $ = (id) => document.getElementById(id);

const draftEl = $("draft");
const resultEl = $("result");
const noticeEl = $("notice");
const timingEl = $("timing");
const statsEl = $("draftStats");
const hintEl = $("hint");
const historyEl = $("history");
const statusEl = $("status");
const humanizeBtn = $("humanizeBtn");
const copyBtn = $("copyBtn");

let currentSessionId = null;
let lastResult = "";
let busy = false;

/* ---------- helpers ---------- */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// Plain text only — safe for anything the server or model sends.
function showNotice(text, kind) {
  noticeEl.className = "notice" + (kind ? " " + kind : "");
  noticeEl.textContent = text;
  noticeEl.hidden = false;
}

// For the few notices we build ourselves (numbers list).
function showNoticeHTML(html, kind) {
  noticeEl.className = "notice" + (kind ? " " + kind : "");
  noticeEl.innerHTML = html;
  noticeEl.hidden = false;
}

function hideNotice() { noticeEl.hidden = true; }

function clearResult(placeholder) {
  resultEl.innerHTML = "";
  if (placeholder) {
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = placeholder;
    resultEl.appendChild(p);
  }
}

function setResult(text) {
  resultEl.textContent = text;
  lastResult = text;
  copyBtn.hidden = !text;
  resultEl.scrollTop = resultEl.scrollHeight;
}

function appendToken(t) {
  const ph = resultEl.querySelector(".placeholder");
  if (ph) ph.remove();
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

function relTime(iso) {
  // Go marshals RFC3339Nano (up to 9 fraction digits); JS wants 3.
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
  } catch (e) {
    historyEl.innerHTML = '<p class="empty">Cannot reach the server.</p>';
  }
}

function renderSessions(list) {
  historyEl.innerHTML = "";
  if (!list.length) {
    const p = document.createElement("p");
    p.className = "empty";
    p.textContent = "No conversations yet.";
    historyEl.appendChild(p);
    return;
  }
  for (const s of list) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "item" + (s.id === currentSessionId ? " active" : "");
    item.dataset.id = s.id;

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = s.title;

    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = `${relTime(s.updatedAt)} · ${s.count} ${s.count === 1 ? "rewrite" : "rewrites"}`;

    const del = document.createElement("span");
    del.className = "del";
    del.title = "Delete";
    del.textContent = "×";
    del.addEventListener("click", (ev) => {
      ev.stopPropagation();
      deleteSession(s.id);
    });

    item.append(title, meta, del);
    item.addEventListener("click", () => openSession(s.id));
    historyEl.appendChild(item);
  }
}

async function deleteSession(id) {
  await fetch("/api/sessions/" + encodeURIComponent(id), { method: "DELETE" });
  if (currentSessionId === id) {
    currentSessionId = null;
    resetPanels();
  }
  loadSessions();
}

async function openSession(id) {
  if (busy) return;
  try {
    const r = await fetch("/api/sessions/" + encodeURIComponent(id));
    if (!r.ok) return;
    const s = await r.json();
    currentSessionId = s.id;
    const m = (s.messages || [])[s.messages.length - 1];
    if (m) {
      draftEl.value = m.draft;
      updateDraftStats();
      hideNotice();
      setResult(m.result);
      showPairNotice(m);
      timingEl.textContent =
        `${(m.ms / 1000).toFixed(1)}s` + (m.retries ? ` · ${m.retries} retries` : "");
    } else {
      resetPanels();
    }
    renderHistoryActive();
  } catch (e) { /* ignore */ }
}

function showPairNotice(m) {
  if (m.missingNumbers && m.missingNumbers.length) {
    const nums = m.missingNumbers.map((n) => "<code>" + esc(n) + "</code>").join(", ");
    const retry = m.retries
      ? `<br>${m.retries} resample${m.retries > 1 ? "s" : ""} (language check).`
      : "";
    showNoticeHTML("Check these numbers against your draft — " + nums + " didn't survive the rewrite." + retry);
  } else if (m.retries) {
    showNotice(`Resampled ${m.retries}× — first attempt came back in the wrong language.`, "info");
  } else {
    hideNotice();
  }
}

function renderHistoryActive() {
  for (const el of historyEl.querySelectorAll(".item")) {
    el.classList.toggle("active", el.dataset.id === currentSessionId);
  }
}

function resetPanels() {
  draftEl.value = "";
  updateDraftStats();
  clearResult("The rewrite streams in here as the model writes it.");
  hideNotice();
  timingEl.textContent = "";
  copyBtn.hidden = true;
}

/* ---------- health ---------- */

async function checkHealth() {
  try {
    const r = await fetch("/api/health");
    const d = await r.json();
    if (d.llama === "ok") {
      statusEl.className = "status ok";
      statusEl.textContent = "model ready";
    } else {
      statusEl.className = "status down";
      statusEl.textContent = "model offline";
    }
  } catch (e) {
    statusEl.className = "status down";
    statusEl.textContent = "server offline";
  }
}

/* ---------- humanize ---------- */

function updateDraftStats() {
  const v = draftEl.value;
  const words = v.trim() ? v.trim().split(/\s+/).length : 0;
  const est = Math.round(v.length / 3.5);
  statsEl.textContent = words ? `${words} words · ~${est} tokens` : "";
}

function setBusy(on) {
  busy = on;
  humanizeBtn.disabled = on;
  humanizeBtn.textContent = on ? "Rewriting…" : "Humanize";
  hintEl.textContent = on ? "model is writing" : "⌘/Ctrl + Enter";
}

async function humanize() {
  if (busy) return;
  const draft = draftEl.value.trim();
  if (!draft) {
    showNotice("Paste some text first.", "info");
    draftEl.focus();
    return;
  }

  hideNotice();
  clearResult("");
  timingEl.textContent = "";
  lastResult = "";
  setBusy(true);

  let res;
  try {
    res = await fetch("/api/humanize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draft, sessionId: currentSessionId }),
    });
  } catch (e) {
    showNotice("Cannot reach the server: " + e.message, "error");
    setBusy(false);
    clearResult("The rewrite streams in here as the model writes it.");
    return;
  }

  if (!res.ok) {
    let msg = "request failed (" + res.status + ")";
    try { msg = (await res.json()).error || msg; } catch (e) {}
    showNotice(msg, "error");
    setBusy(false);
    clearResult("The rewrite streams in here as the model writes it.");
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
        appendToken(d.t);
        break;
      case "retry":
        removeCaret();
        clearResult("");
        showNotice(`Attempt ${d.attempt}: the first attempt came back in Chinese, resampling…`, "info");
        break;
      case "done":
        removeCaret();
        setResult(d.text);
        lastResult = d.text;
        currentSessionId = d.sessionId;
        showPairNotice(d);
        timingEl.textContent =
          `${(d.ms / 1000).toFixed(1)}s · ~${d.draftTokens} tok in` +
          (d.attempts > 1 ? ` · ${d.attempts} attempts` : "");
        break;
      case "error":
        removeCaret();
        failed = true;
        showNotice(d.message, "error");
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
    showNotice("stream interrupted: " + e.message, "error");
    failed = true;
  }

  removeCaret();
  if (!failed && !lastResult && !resultEl.textContent.trim()) {
    clearResult("The model returned nothing — try again.");
  }
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

$("newBtn").addEventListener("click", () => {
  if (busy) return;
  currentSessionId = null;
  resetPanels();
  renderHistoryActive();
  draftEl.focus();
});

copyBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(lastResult);
    copyBtn.textContent = "Copied";
    setTimeout(() => (copyBtn.textContent = "Copy"), 1400);
  } catch (e) {
    showNotice("Clipboard unavailable — select the text and copy manually.", "info");
  }
});

/* ---------- start ---------- */

loadSessions();
checkHealth();
setInterval(checkHealth, 30000);
updateDraftStats();
