/* shared by the typing page (index.html) and the listen page (listen.html) */
"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
};
const now = () => performance.now();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------------- account + synced storage ----------------
   The server injects window.LT_BOOT = {auth, user, data} into each page. When signed in,
   the browser storage keys below are mirrored to the user's row in SQLite. */
const BOOT = window.LT_BOOT || { auth: false, user: null, data: null };
const SYNC_KEYS = ["lt_settings", "lt_listen", "lt_history", "lt_tracks"];
const _pending = new Map();
let _syncTimer = 0;

function _flushSync(keepalive = false) {
  clearTimeout(_syncTimer);
  for (const [key, body] of _pending) {
    fetch(`/api/data/${key}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body, keepalive }).catch(() => {});
  }
  _pending.clear();
}
function _queueSync(key, json) {
  if (!BOOT.user || !SYNC_KEYS.includes(key)) return;
  _pending.set(key, json);
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(_flushSync, 800);
}
addEventListener("pagehide", () => _flushSync(true));

if (BOOT.user) {
  try {
    const sameUser = localStorage.getItem("lt_uid") === String(BOOT.user.id);
    const fresh = localStorage.getItem("lt_uid") == null; // first sign-in on this browser: keep local data
    for (const k of SYNC_KEYS) {
      if (BOOT.data && k in BOOT.data) localStorage.setItem(k, JSON.stringify(BOOT.data[k]));
      else if (sameUser || fresh) { const v = localStorage.getItem(k); if (v) _queueSync(k, v); }
      else localStorage.removeItem(k); // someone else's data on a shared browser
    }
    localStorage.setItem("lt_uid", String(BOOT.user.id));
  } catch {}
}

function store(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function storeSet(key, val) {
  const json = JSON.stringify(val);
  try { localStorage.setItem(key, json); } catch {}
  _queueSync(key, json);
}

async function signOut() {
  _flushSync();
  try { await fetch("/api/auth/logout", { method: "POST" }); } catch {}
  location.href = "/login.html";
}

function mountUserChip() {
  const nav = document.querySelector("header.top nav");
  if (!nav) return;
  if (BOOT.auth && !BOOT.user) {
    const a = document.createElement("a");
    a.className = "icon-btn user-chip";
    a.href = "/login.html?next=" + encodeURIComponent(location.pathname + location.search);
    a.innerHTML = "◉<span>sign in</span>";
    a.title = "sign in with Google to search and play songs";
    nav.appendChild(a);
    return;
  }
  if (!BOOT.user) return;
  const u = BOOT.user;
  const b = document.createElement("button");
  b.className = "icon-btn user-chip";
  b.title = `signed in as ${u.email} · click to sign out`;
  b.innerHTML = (u.picture ? `<img src="${esc(u.picture)}" alt="" referrerpolicy="no-referrer" />` : "◉") +
    `<span>${esc((u.name || u.email || "").split(" ")[0])}</span>`;
  b.addEventListener("click", () => { if (confirm(`sign out of ${u.email}?`)) signOut(); });
  nav.appendChild(b);
}
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mountUserChip);
else mountUserChip();

// the colour theme of the site chrome is shared by both pages
document.documentElement.dataset.theme = store("lt_settings", {}).theme || "midnight";

async function api(url, opts) {
  const r = await fetch(url, opts);
  if (r.status === 401 && BOOT.auth) { location.href = "/login.html?next=" + encodeURIComponent(location.pathname + location.search); throw new Error("sign in required"); }
  let data = null;
  try { data = await r.json(); } catch {}
  if (!r.ok) throw new Error((data && data.detail) || `${r.status} ${r.statusText}`);
  return data;
}

/* ---------------- lyrics ---------------- */
const TS_RE = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g;

function parseLRC(lrc) {
  let offset = 0;
  const out = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const off = raw.match(/^\[offset:\s*([+-]?\d+)\]/i);
    if (off) { offset = Number(off[1]) / 1000; continue; }
    const stamps = [...raw.matchAll(TS_RE)];
    if (!stamps.length) continue;
    const text = raw.replace(TS_RE, "").replace(/<\d+:\d+(?:\.\d+)?>/g, "").trim();
    for (const m of stamps) out.push({ t: Number(m[1]) * 60 + Number(m[2].replace(":", ".")), text });
  }
  out.forEach((l) => (l.t = Math.max(0, l.t - offset)));
  return out.sort((a, b) => a.t - b.t);
}

/** plain lyrics → lines with estimated timing spread across the song */
function plainToLines(text, duration) {
  const lines = text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !/^\[[^\]]*\]$/.test(s));
  if (!lines.length) return [];
  const d = duration || 210;
  const start = d * 0.08, end = d * 0.95;
  const total = lines.reduce((a, l) => a + l.length + 4, 0);
  let acc = 0;
  return lines.map((l) => {
    const t = start + ((end - start) * acc) / total;
    acc += l.length + 4;
    return { t, text: l };
  });
}

function lyricsToLines(l, duration) {
  if (!l) return { lines: [], synced: false };
  if (l.syncedLyrics) return { lines: parseLRC(l.syncedLyrics), synced: true };
  return { lines: plainToLines(l.plainLyrics || "", duration), synced: false };
}

function lyricsLabel(l, synced) {
  if (!l) return "no lyrics loaded";
  const who = [l.artistName, l.trackName].filter(Boolean).join(" – ");
  return `lyrics: ${who || "custom"} · ${l.source || "custom"} · ${synced ? "synced" : "unsynced (estimated timing)"}`;
}

async function fetchLyrics(params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
  return api(`/api/lyrics?${qs}`);
}

/* ---------------- tracks ---------------- */
const loadTracks = () => store("lt_tracks", {});
function rememberTrack(t) {
  const all = loadTracks();
  all[t.key] = { key: t.key, title: t.title, channel: t.channel, duration: t.duration, thumb: t.thumb, url: t.url, artist: t.artist, track: t.track, last: Date.now() };
  storeSet("lt_tracks", all);
}
function trackFromQuery() {
  const key = new URLSearchParams(location.search).get("track");
  return key ? loadTracks()[key] || null : null;
}

/**
 * Downloads the audio and finds lyrics in parallel.
 * waitAudio=false resolves as soon as lyrics are known; `audioReady` settles when the download does.
 */
async function loadTrack(tr, { waitAudio = true, onStep = () => {} } = {}) {
  const prepUrl = `/api/prepare/${tr.key}${tr.url ? `?url=${encodeURIComponent(tr.url)}` : ""}`;
  const audioReady = api(prepUrl, { method: "POST" })
    .then((m) => { onStep("audio", "done"); return m; })
    .catch((e) => { onStep("audio", "fail"); throw e; });
  audioReady.catch(() => {});
  const pLyr = fetchLyrics({ title: tr.title, channel: tr.channel, duration: tr.duration, artist: tr.artist, track: tr.track }).catch(() => null);

  let meta = null, lyr;
  if (waitAudio) [meta, lyr] = await Promise.all([audioReady, pLyr]);
  else lyr = await pLyr;

  if (!lyr?.best) {
    meta = meta || (await audioReady.catch(() => null));
    if (meta && (meta.artist || meta.track)) {
      lyr = (await fetchLyrics({ artist: meta.artist, track: meta.track || meta.title, duration: meta.duration }).catch(() => null)) || lyr;
    }
  }
  onStep("lyrics", lyr?.best ? "done" : "fail");
  const track = { ...tr, ...(meta || {}) };
  rememberTrack(track);
  return { track, lyr, audioReady };
}

/* ---------------- search ---------------- */
function initSearch(onPick) {
  $("#searchForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = $("#searchInput").value.trim();
    if (!q) return;
    const st = $("#searchStatus");
    st.className = "status";
    st.textContent = "searching…";
    $("#results").innerHTML = "";
    try {
      const { results } = await api(`/api/search?q=${encodeURIComponent(q)}&source=${$("#sourceSel").value}`);
      st.textContent = results.length ? `${results.length} results — pick a song` : "no results";
      renderCards($("#results"), results, onPick);
    } catch (err) {
      st.className = "status err";
      st.textContent = err.message;
    }
  });
}

function renderCards(box, list, onPick) {
  box.innerHTML = "";
  for (const r of list) {
    const c = document.createElement("button");
    c.className = "card";
    c.innerHTML = `
      <div class="thumb">${r.thumb ? `<img loading="lazy" src="${esc(r.thumb)}" alt="">` : ""}
        ${r.duration ? `<span class="dur">${fmtTime(r.duration)}</span>` : ""}</div>
      <div class="meta"><div class="t">${esc(r.title)}</div><div class="c">${esc(r.channel || "")}</div></div>`;
    c.addEventListener("click", () => onPick(r));
    box.appendChild(c);
  }
}

/* ---------------- loading screen steps ---------------- */
function resetSteps() {
  ["#stepAudio", "#stepLyrics"].forEach((id) => $(id).classList.remove("done", "fail"));
}
function setStep(which, state) {
  const li = $(which === "audio" ? "#stepAudio" : "#stepLyrics");
  li.classList.remove("done", "fail");
  if (state) li.classList.add(state);
}

/* ---------------- modals / toast ---------------- */
function openModal(sel) { $(sel).classList.add("open"); }
function closeModals() { $$(".modal.open").forEach((m) => m.classList.remove("open")); }
document.addEventListener("click", (e) => {
  const m = e.target.closest(".modal");
  if (m && (e.target === m || e.target.closest("[data-close]"))) closeModals();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && $(".modal.open")) { e.stopImmediatePropagation(); closeModals(); }
}, true);

let toastT;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastT);
  toastT = setTimeout(() => t.classList.remove("show"), 2600);
}

/* ---------------- lyrics picker modal ---------------- */
const LyricsPicker = {
  // getState() → { track, lyrics, result }, onPick(lyricsObject)
  init(getState, onPick) {
    this.getState = getState;
    this.onPick = onPick;
    $("#lyricsSearchForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const q = $("#lyricsSearchInput").value.trim();
      if (!q) return;
      $("#lyricsCandidates").innerHTML = `<div class="empty">searching…</div>`;
      try {
        const res = await fetchLyrics({ q, duration: this.getState().track?.duration });
        this.render(res.candidates || []);
      } catch (err) {
        $("#lyricsCandidates").innerHTML = `<div class="empty">${esc(err.message)}</div>`;
      }
    });
    $("#usePastedBtn").addEventListener("click", () => {
      const txt = $("#pasteLyrics").value;
      if (!txt.trim()) return toast("paste some lyrics first");
      TS_RE.lastIndex = 0;
      const synced = TS_RE.test(txt);
      TS_RE.lastIndex = 0;
      this.onPick({ id: null, source: "pasted", trackName: this.getState().track?.title, artistName: "", syncedLyrics: synced ? txt : null, plainLyrics: synced ? null : txt });
      closeModals();
    });
  },
  open(msg = "") {
    const { result } = this.getState();
    $("#lyricsModalMsg").textContent = msg;
    $("#lyricsModalMsg").className = msg ? "status err" : "status";
    const q = result?.query;
    $("#lyricsSearchInput").value = q ? [q.artist, q.track].filter(Boolean).join(" ") : "";
    this.render(result?.candidates || []);
    openModal("#lyricsModal");
  },
  render(list) {
    const { track, lyrics } = this.getState();
    const box = $("#lyricsCandidates");
    box.innerHTML = list.length ? "" : `<div class="empty">no candidates</div>`;
    for (const c of list) {
      const b = document.createElement("button");
      b.className = "cand" + (lyrics && lyrics.id === c.id ? " current" : "");
      const dd = c.duration && track?.duration ? Math.round(c.duration - track.duration) : null;
      b.innerHTML = `<div><div class="ct">${esc(c.trackName || "?")}</div><div class="ca">${esc(c.artistName || "")}${c.albumName ? " · " + esc(c.albumName) : ""}</div></div>
        <span class="tag">${c.duration ? fmtTime(c.duration) : "?"}${dd !== null && Math.abs(dd) > 2 ? ` (${dd > 0 ? "+" : ""}${dd}s)` : ""}</span>
        <span class="tag ${c.synced ? "synced" : ""}">${c.synced ? "synced" : c.hasLyrics ? "plain" : "none"}</span>`;
      b.addEventListener("click", async () => {
        try {
          const full = await api(`/api/lyrics/id/${c.id}`);
          if (!full.syncedLyrics && !full.plainLyrics) return toast("that entry has no lyrics");
          this.onPick(full);
          closeModals();
          toast("lyrics loaded");
        } catch (e) { toast(e.message); }
      });
      box.appendChild(b);
    }
  },
};

/* ---------------- settings form renderer ---------------- */
function renderSchema(body, schema, values, onChange) {
  body.innerHTML = "";
  for (const g of schema) {
    const grp = document.createElement("div");
    grp.className = "set-group";
    grp.innerHTML = `<h3>${esc(g.group)}</h3>`;
    for (const it of g.items) {
      const row = document.createElement("div");
      row.className = "set-row";
      row.innerHTML = `<div><div class="name">${esc(it.label)}</div>${it.desc ? `<div class="desc">${esc(it.desc)}</div>` : ""}</div>`;
      const ctl = document.createElement("div");
      if (it.type === "toggle") {
        ctl.innerHTML = `<label class="switch"><input type="checkbox" ${values[it.key] ? "checked" : ""}><span class="slider"></span></label>`;
        $("input", ctl).addEventListener("change", (e) => onChange(it.key, e.target.checked));
      } else if (it.type === "range") {
        ctl.className = "range";
        ctl.innerHTML = `<input type="range" min="${it.min}" max="${it.max}" step="${it.step}" value="${values[it.key]}"><output>${it.fmt(values[it.key])}</output>`;
        const inp = $("input", ctl), out = $("output", ctl);
        inp.addEventListener("input", () => { out.textContent = it.fmt(Number(inp.value)); onChange(it.key, Number(inp.value)); });
      } else if (it.type === "seg") {
        ctl.className = "seg";
        for (const [val, lab] of it.options) {
          const b = document.createElement("button");
          b.textContent = lab;
          if (values[it.key] === val) b.className = "on";
          b.addEventListener("click", () => {
            $$("button", ctl).forEach((x) => x.classList.remove("on"));
            b.classList.add("on");
            onChange(it.key, val);
          });
          ctl.appendChild(b);
        }
      } else if (it.type === "select") {
        ctl.innerHTML = `<select class="sel">${it.options.map(([v, l]) => `<option value="${esc(v)}" ${values[it.key] === v ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
        $("select", ctl).addEventListener("change", (e) => onChange(it.key, e.target.value));
      }
      row.appendChild(ctl);
      grp.appendChild(row);
    }
    body.appendChild(grp);
  }
}
