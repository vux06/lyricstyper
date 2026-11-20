/* lyricstyper — listen page: audio + animated lyrics. needs common.js */
"use strict";

const LDEF = {
  style: "flow", font: "auto", bg: "cover", beat: true, showNext: true,
  textScale: 1, rate: 1, offset: 0, volume: 0.8, loop: false,
};
let ls = { ...LDEF, ...store("lt_listen", {}) };
const saveLs = () => storeSet("lt_listen", ls);

const STYLES = [["flow", "flow"], ["karaoke", "karaoke"], ["kinetic", "kinetic"], ["typewriter", "typewriter"], ["neon", "neon"]];
const FONTS = [
  ["auto", "style default"], ["Montserrat", "Montserrat"], ["Anton", "Anton"], ["Playfair Display", "Playfair (serif)"],
  ["Space Mono", "Space Mono"], ["Tilt Neon", "Tilt Neon"], ["Caveat", "Caveat (handwritten)"], ["Lexend Deca", "Lexend"],
];
const OPTS = [
  { group: "look", items: [
    { key: "font", type: "select", label: "font", desc: "override the style's font", options: FONTS },
    { key: "bg", type: "seg", label: "background", options: [["cover", "cover art"], ["aurora", "aurora"], ["dark", "dark"]] },
    { key: "beat", type: "toggle", label: "beat pulse", desc: "background and text react to the bass" },
    { key: "showNext", type: "toggle", label: "show next line", desc: "preview of the upcoming line" },
    { key: "textScale", type: "range", label: "text size", min: 0.6, max: 1.6, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  ]},
  { group: "playback", items: [
    { key: "rate", type: "seg", label: "speed", desc: "slow it down to catch every word", options: [[0.5, "0.5×"], [0.75, "0.75×"], [0.9, "0.9×"], [1, "1×"], [1.25, "1.25×"]] },
    { key: "offset", type: "range", label: "lyrics offset", desc: "+ = lyrics later", min: -3, max: 3, step: 0.1, fmt: (v) => `${v > 0 ? "+" : ""}${Number(v).toFixed(1)}s` },
    { key: "loop", type: "toggle", label: "loop the song" },
  ]},
];

const stage = $("#stage"), lyr = $("#lyr"), audio = $("#audio");
const L = { track: null, lyrics: null, result: null, lines: [], synced: false, shown: -99, phase: "", loadToken: 0 };

/* ---------------- views ---------------- */
function showView(v) {
  $("#viewSearch").classList.toggle("active", v === "search");
  $("#viewLoading").classList.toggle("active", v === "loading");
  stage.classList.toggle("open", v === "player");
  if (v !== "player") {
    audio.pause();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    $("#opts").classList.remove("open");
  }
  if (v === "search") { renderRecent(); setTimeout(() => $("#searchInput").focus(), 30); }
}

function renderRecent() {
  const list = Object.values(loadTracks()).sort((a, b) => (b.last || 0) - (a.last || 0)).slice(0, 8);
  const box = $("#recent");
  box.innerHTML = list.length ? `<h2>recently played</h2><div class="results" id="recentCards"></div>` : "";
  if (list.length) renderCards($("#recentCards"), list, openTrack);
}

initSearch(openTrack);

async function openTrack(tr) {
  const token = ++L.loadToken;
  showView("loading");
  $("#loadThumb").src = tr.thumb || "";
  $("#loadThumb").style.display = tr.thumb ? "" : "none";
  $("#loadTitle").textContent = tr.title;
  $("#loadError").textContent = "";
  resetSteps();
  let res;
  try {
    res = await loadTrack(tr, { onStep: setStep });
  } catch (err) {
    if (token === L.loadToken) $("#loadError").textContent = err.message;
    return;
  }
  if (token !== L.loadToken) return;
  L.track = res.track;
  L.result = res.lyr;
  const key = encodeURIComponent(tr.key);
  history.replaceState(null, "", `?track=${key}`);
  $("#typeLink").href = `index.html?track=${key}`;
  $("#typeFooter").href = `index.html?track=${key}`;
  $("#stTitle").textContent = L.track.title;
  audio.src = `/api/audio/${tr.key}`;
  audio.load();
  setBackground(L.track);
  showView("player");
  setLyrics(res.lyr?.best || null);
  if (!res.lyr?.best) LyricsPicker.open("couldn't find lyrics automatically — search below or paste them.");
  play();
}

$("#loadCancel").addEventListener("click", () => { L.loadToken++; showView("search"); });
$("#backBtn").addEventListener("click", () => { history.replaceState(null, "", location.pathname); showView("search"); });

/* ---------------- lyrics & timing ---------------- */
const duration = () => (isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0) || L.track?.duration || 240;

/** per-word timing: each line is spread across its (capped) duration, weighted by characters */
function timeLines(raw, dur) {
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const text = raw[i].text.trim();
    if (!text) continue;
    const t = raw[i].t;
    let end = dur;
    for (let j = i + 1; j < raw.length; j++) if (raw[j].t > t) { end = raw[j].t; break; }
    const toks = text.split(/\s+/);
    const chars = toks.reduce((a, w) => a + [...w].length, 0) + toks.length - 1;
    const span = Math.max(0.5, Math.min(Math.max(0.5, end - t), chars * 0.085 + 1.0));
    let acc = 0;
    const words = toks.map((w) => {
      const n = [...w].length;
      const t0 = t + (span * acc) / chars;
      acc += n;
      const t1 = t + (span * acc) / chars;
      acc += 1;
      return { text: w, t0, t1 };
    });
    out.push({ t, end, spanEnd: t + span, text, words });
  }
  return out;
}

function cleanTitle(s) {
  return (s || "").replace(/\s*[\(\[][^\)\]]*(official|video|audio|lyric|visuali|hd|4k|mv)[^\)\]]*[\)\]]/gi, "").trim();
}

function setLyrics(l) {
  L.lyrics = l;
  const r = lyricsToLines(l, duration());
  L.synced = r.synced;
  L.lines = timeLines(r.lines, duration());
  $("#stLyrics").textContent = lyricsLabel(l, L.synced);
  let title = l?.trackName, artist = l?.artistName;
  if (!title || !artist) {
    const t = cleanTitle(title || L.track?.title);
    const m = t.split(/\s[-–—]\s/);
    if (m.length > 1) { artist = artist || m[0]; title = m.slice(1).join(" – "); } else title = t;
  }
  $("#tcTitle").textContent = title || "";
  $("#tcArtist").textContent = artist || L.track?.channel || "";
  mount();
}

LyricsPicker.init(() => ({ track: L.track, lyrics: L.lyrics, result: L.result }), setLyrics);
$("#changeLyricsBtn").addEventListener("click", () => LyricsPicker.open());

audio.addEventListener("loadedmetadata", () => {
  $("#tDur").textContent = fmtTime(audio.duration);
  if (L.lyrics) { // real duration known → refine timing of the last line / plain lyrics
    const r = lyricsToLines(L.lyrics, duration());
    L.lines = timeLines(r.lines, duration());
    mount();
  }
});

/** where are we in the song? */
function locate(t) {
  const lines = L.lines;
  if (!lines.length) return { idx: -1, phase: "none" };
  if (t < lines[0].t) return { idx: -1, phase: lines[0].t > 3 && lines[0].t - t > 0.6 ? "intro" : "wait" };
  let lo = 0, hi = lines.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lines[mid].t <= t) lo = mid; else hi = mid - 1; }
  const ln = lines[lo];
  if (t <= ln.spanEnd + 1.5 || ln.end - ln.spanEnd < 4) return { idx: lo, phase: "line" };
  return { idx: lo, phase: lo === lines.length - 1 ? "outro" : "gap" };
}

/* ---------------- rendering ---------------- */
function wordsHTML(ln, style) {
  const lens = ln.words.map((w) => [...w.text].length);
  const maxLen = Math.max(...lens);
  return ln.words.map((w, i) => {
    let cls = "w";
    if (style === "kinetic") {
      const n = lens[i];
      if (n === maxLen && n >= 4) cls += " k-xl";
      else if (n >= 6) cls += " k-l";
      else if (n <= 2) cls += " k-s";
    }
    const inner = style === "typewriter" ? [...w.text].map((c) => `<i>${esc(c)}</i>`).join("") : esc(w.text);
    return `<span class="${cls}">${inner}</span>`;
  }).join(" ");
}

const R = { curEl: null, words: [], line: null, wstate: [], flow: null, fls: [], caret: null };

function mount() {
  stage.dataset.style = ls.style;
  L.shown = -99;
  L.phase = "";
  R.curEl = null; R.words = []; R.line = null; R.caret = null;
  if (!L.lines.length) {
    lyr.innerHTML = `<div class="nolyr">no lyrics loaded — <button class="slink" id="noLyrBtn">find lyrics</button></div>`;
    $("#noLyrBtn").addEventListener("click", () => LyricsPicker.open());
    stage.dataset.phase = "none";
    return;
  }
  if (ls.style === "flow") {
    lyr.innerHTML = `<div class="flow">${L.lines.map((ln, i) => `<div class="fl" data-i="${i}">${wordsHTML(ln, "flow")}</div>`).join("")}</div>`;
    R.flow = $(".flow", lyr);
    R.fls = [...R.flow.children];
    R.fls.forEach((el) => el.addEventListener("click", () => seekLyric(L.lines[+el.dataset.i].t)));
  } else {
    lyr.innerHTML = `<div class="cur"></div><div class="nxt"></div>`;
  }
  update(true);
}

function setShown(shown, idx) {
  if (ls.style === "flow") return flowSet(shown, idx);
  if (R.curEl) {
    const old = R.curEl;
    old.classList.remove("in");
    old.classList.add("out");
    setTimeout(() => old.remove(), 700);
  }
  R.curEl = null; R.words = []; R.line = null; R.caret = null;
  if (shown >= 0) {
    const ln = L.lines[shown];
    const el = document.createElement("div");
    el.className = "ln in";
    if (ls.style === "kinetic") el.style.setProperty("--tilt", `${(((shown * 37) % 7) - 3) * 0.7}deg`);
    el.innerHTML = wordsHTML(ln, ls.style);
    $(".cur", lyr).appendChild(el);
    R.curEl = el;
    R.words = [...el.querySelectorAll(".w")];
    R.line = ln;
    R.wstate = [];
  }
  const nextI = shown >= 0 ? shown + 1 : idx + 1;
  $(".nxt", lyr).textContent = ls.showNext && L.lines[nextI] ? L.lines[nextI].text : "";
}

function flowSet(shown, idx) {
  // clear word fills of the line we are leaving
  R.words.forEach((w) => w.style.removeProperty("--p"));
  const focus = shown >= 0 ? shown : Math.min(L.lines.length - 1, idx + 1);
  const pastBefore = shown >= 0 ? shown : idx + 1;
  R.fls.forEach((el, i) => {
    el.classList.toggle("active", i === shown);
    el.classList.toggle("past", i < pastBefore);
    el.style.setProperty("--d", Math.abs(i - focus));
  });
  const f = R.fls[focus];
  R.flow.style.transform = `translateY(${lyr.clientHeight * 0.42 - (f.offsetTop + f.offsetHeight / 2)}px)`;
  R.curEl = shown >= 0 ? f : null;
  R.words = R.curEl ? [...f.querySelectorAll(".w")] : [];
  R.line = shown >= 0 ? L.lines[shown] : null;
  R.wstate = [];
}

/** per-frame word progress for the current line */
function frameWords(t) {
  if (!R.line) return;
  const tw = ls.style === "typewriter";
  let caretEl = null;
  R.line.words.forEach((w, i) => {
    const p = clamp((t - w.t0) / Math.max(0.05, w.t1 - w.t0), 0, 1);
    const q = Math.round(p * 40) / 40;
    const el = R.words[i];
    if (R.wstate[i] !== q) {
      R.wstate[i] = q;
      el.style.setProperty("--p", q);
      el.classList.toggle("on", p > 0);
      el.classList.toggle("done", p >= 1);
      if (tw) {
        const cs = el.children, n = Math.ceil(q * cs.length);
        for (let k = 0; k < cs.length; k++) cs[k].classList.toggle("on", k < n);
      }
    }
    if (tw && q > 0) {
      const cs = el.children;
      caretEl = cs[Math.max(0, Math.ceil(q * cs.length) - 1)];
    }
  });
  if (tw && caretEl !== R.caret) {
    R.caret?.classList.remove("tw-caret");
    caretEl?.classList.add("tw-caret");
    R.caret = caretEl;
  }
}

function update(force) {
  const t = audio.currentTime - ls.offset;
  const { idx, phase } = locate(t);
  if (phase !== L.phase) { stage.dataset.phase = phase; L.phase = phase; }
  const shown = phase === "line" ? idx : -1;
  if (shown !== L.shown || force) {
    // in flow style keep the list positioned even with nothing sung
    if (shown !== L.shown || ls.style === "flow" || force) setShown(shown, idx);
    L.shown = shown;
  }
  frameWords(t);
}

/* ---------------- audio: playback + beat detection ---------------- */
const FX = {
  ctx: null, an: null, gain: null, buf: null, avg: 0, beat: 0,
  ensure() {
    if (!this.ctx) {
      try {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        const src = this.ctx.createMediaElementSource(audio);
        this.an = this.ctx.createAnalyser();
        this.an.fftSize = 1024;
        this.an.smoothingTimeConstant = 0.55;
        this.gain = this.ctx.createGain();
        this.gain.gain.value = ls.volume;
        src.connect(this.an);
        this.an.connect(this.gain).connect(this.ctx.destination);
        this.buf = new Uint8Array(this.an.frequencyBinCount);
      } catch { this.ctx = null; }
    }
    if (this.ctx?.state === "suspended") this.ctx.resume();
  },
  setVolume(v) {
    if (this.gain) this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    else audio.volume = v;
  },
  sample() {
    if (!this.an || !ls.beat || audio.paused) {
      this.beat *= 0.9;
    } else {
      this.an.getByteFrequencyData(this.buf);
      const binHz = this.ctx.sampleRate / this.an.fftSize;
      const lo = Math.max(1, Math.floor(40 / binHz)), hi = Math.max(lo + 1, Math.ceil(160 / binHz));
      let e = 0;
      for (let k = lo; k <= hi; k++) e += this.buf[k];
      e /= (hi - lo + 1) * 255;
      this.avg = this.avg * 0.96 + e * 0.04;
      const hit = clamp((e - this.avg * 1.08) * 7, 0, 1);
      this.beat = Math.max(hit, this.beat * 0.86);
    }
    stage.style.setProperty("--beat", this.beat.toFixed(3));
  },
};

function play() {
  FX.ensure();
  audio.play().then(() => stage.classList.remove("needplay")).catch(() => stage.classList.add("needplay"));
}
function togglePlay() { if (audio.paused) play(); else audio.pause(); }

audio.addEventListener("play", () => { $("#playBtn").textContent = "❚❚"; stage.classList.remove("needplay"); poke(); });
audio.addEventListener("pause", () => { $("#playBtn").textContent = "▶"; poke(); });
audio.addEventListener("ended", () => {
  if (ls.loop) { audio.currentTime = 0; play(); }
  else { $("#tcKicker").textContent = "that was"; stage.dataset.phase = "outro"; L.phase = "outro"; }
});
audio.addEventListener("seeking", () => { $("#tcKicker").textContent = "now playing"; });

function seekLyric(lyricT) {
  audio.currentTime = clamp(lyricT + ls.offset - 0.05, 0, duration());
  update(true);
  if (audio.paused) play();
}
function jumpLine(dir) {
  if (!L.lines.length) return;
  const t = audio.currentTime - ls.offset;
  const { idx } = locate(t);
  let target;
  if (dir < 0) {
    // go to the start of the current line, or the previous one if we are right at its start
    target = idx >= 0 && t - L.lines[idx].t > 1.2 ? idx : idx - 1;
  } else target = idx + 1;
  target = clamp(target, 0, L.lines.length - 1);
  seekLyric(L.lines[target].t);
}

/* ---------------- main loop ---------------- */
let lastUi = 0;
function loop() {
  if (stage.classList.contains("open")) {
    FX.sample();
    update(false);
    if (now() - lastUi > 250) {
      lastUi = now();
      const d = duration();
      $("#tCur").textContent = fmtTime(audio.currentTime);
      $("#tDur").textContent = fmtTime(d);
      if (!seeking) $("#seek").value = Math.round((audio.currentTime / d) * 1000) || 0;
    }
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/* ---------------- background palette from cover art ---------------- */
function rgb2hsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function extractPalette(img) {
  const c = document.createElement("canvas");
  c.width = 48; c.height = 27;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(img, 0, 0, 48, 27);
  const d = g.getImageData(0, 0, 48, 27).data;
  const bins = Array.from({ length: 12 }, () => ({ w: 0, h: 0, s: 0 }));
  for (let i = 0; i < d.length; i += 4) {
    const [h, s, l] = rgb2hsl(d[i], d[i + 1], d[i + 2]);
    if (l < 0.1 || l > 0.92 || s < 0.18) continue;
    const w = s * (1 - Math.abs(l - 0.5));
    const b = bins[Math.floor(h * 12) % 12];
    b.w += w; b.h += h * w; b.s += s * w;
  }
  const picks = bins.filter((b) => b.w > 0.4).sort((a, b) => b.w - a.w).slice(0, 3).map((b) => ({ h: b.h / b.w, s: b.s / b.w }));
  return picks;
}

function applyPalette(picks) {
  const base = picks?.[0] || { h: 0.72, s: 0.7 };
  const cols = [base, picks?.[1] || { h: (base.h + 0.1) % 1, s: base.s }, picks?.[2] || { h: (base.h + 0.9) % 1, s: base.s }];
  const hsl = (c, l, minS = 0.55) => `hsl(${Math.round(c.h * 360)} ${Math.round(clamp(Math.max(c.s, minS), 0, 0.95) * 100)}% ${l}%)`;
  stage.style.setProperty("--c1", hsl(cols[0], 48));
  stage.style.setProperty("--c2", hsl(cols[1], 52));
  stage.style.setProperty("--c3", hsl(cols[2], 55));
  stage.style.setProperty("--accent", hsl(cols[0], 72, 0.75));
}

function setBackground(tr) {
  const url = `/api/thumb/${tr.key}`;
  $("#bgImg").style.backgroundImage = `url("${url}")`;
  const img = new Image();
  img.onload = () => { try { applyPalette(extractPalette(img)); } catch { applyPalette(null); } };
  img.onerror = () => applyPalette(null);
  img.src = url;
}

/* ---------------- options & controls ---------------- */
function applyLs() {
  stage.dataset.bg = ls.bg;
  stage.style.setProperty("--ts", ls.textScale);
  if (ls.font === "auto") stage.style.removeProperty("--font-o");
  else stage.style.setProperty("--font-o", `"${ls.font}"`);
  audio.defaultPlaybackRate = ls.rate;
  audio.playbackRate = ls.rate;
  FX.setVolume(ls.volume);
  $("#vol").value = ls.volume;
  $$("#styleChips button").forEach((b) => b.classList.toggle("on", b.dataset.s === ls.style));
}

function setLs(key, val) {
  ls[key] = val;
  saveLs();
  applyLs();
  if (key === "style" || key === "showNext") mount();
  if (key === "textScale" || key === "font") requestAnimationFrame(() => update(true));
}

$("#styleChips").innerHTML = STYLES.map(([k, lab], i) => `<button data-s="${k}" title="${lab} (${i + 1})">${lab}</button>`).join("");
$$("#styleChips button").forEach((b) => b.addEventListener("click", () => setLs("style", b.dataset.s)));

$("#optsBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  renderSchema($("#optsBody"), OPTS, ls, setLs);
  $("#opts").classList.toggle("open");
});
stage.addEventListener("click", (e) => {
  if (!e.target.closest("#opts") && !e.target.closest("#optsBtn")) $("#opts").classList.remove("open");
});

$("#playBtn").addEventListener("click", togglePlay);
$("#bigPlay").addEventListener("click", play);
$("#prevLine").addEventListener("click", () => jumpLine(-1));
$("#nextLine").addEventListener("click", () => jumpLine(1));
$("#vol").addEventListener("input", (e) => { ls.volume = Number(e.target.value); saveLs(); FX.setVolume(ls.volume); });

let seeking = false;
$("#seek").addEventListener("input", (e) => {
  seeking = true;
  audio.currentTime = (Number(e.target.value) / 1000) * duration();
  update(true);
});
$("#seek").addEventListener("change", () => { seeking = false; });

function toggleFs() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else stage.requestFullscreen?.().catch(() => {});
}
$("#fsBtn").addEventListener("click", toggleFs);
document.addEventListener("fullscreenchange", () => requestAnimationFrame(() => update(true)));
window.addEventListener("resize", () => { if (stage.classList.contains("open")) update(true); });

// hide controls + cursor while playing and the mouse is still
let idleT;
function poke() {
  stage.classList.remove("idle");
  clearTimeout(idleT);
  idleT = setTimeout(() => {
    if (!audio.paused && !$("#opts").classList.contains("open") && !$(".modal.open")) stage.classList.add("idle");
  }, 2600);
}
stage.addEventListener("mousemove", poke);

document.addEventListener("keydown", (e) => {
  if (!stage.classList.contains("open") || $(".modal.open")) return;
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" && document.activeElement.type !== "range") return;
  if (tag === "TEXTAREA" || tag === "SELECT") return;
  const k = e.key;
  if (k === " ") { e.preventDefault(); togglePlay(); }
  else if (k === "ArrowLeft") { e.preventDefault(); audio.currentTime = Math.max(0, audio.currentTime - 5); update(true); }
  else if (k === "ArrowRight") { e.preventDefault(); audio.currentTime = Math.min(duration(), audio.currentTime + 5); update(true); }
  else if (k === "ArrowUp") { e.preventDefault(); jumpLine(-1); }
  else if (k === "ArrowDown") { e.preventDefault(); jumpLine(1); }
  else if (k === "f" || k === "F") toggleFs();
  else if (k === "Escape") $("#opts").classList.remove("open");
  else if (/^[1-5]$/.test(k)) setLs("style", STYLES[Number(k) - 1][0]);
  else return;
  poke();
});
// keep buttons from swallowing the space bar after a click
stage.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) b.blur(); });

/* ---------------- boot ---------------- */
applyLs();
applyPalette(null);
const fromQuery = trackFromQuery();
if (fromQuery) openTrack(fromQuery);
else showView("search");
