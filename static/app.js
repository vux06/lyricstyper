/* lyricstyper — typing page. needs common.js */
"use strict";

/* =====================================================================================
   settings
   ===================================================================================== */
const DEFAULTS = {
  songOn: true,           // false = type the lyrics in silence
  skipIntro: true,
  endOnSongEnd: true,
  finishOnAllTyped: true,
  pauseOnBlur: true,
  ignoreCase: true,
  ignorePunct: true,
  simplifyChars: true,
  stripBrackets: true,
  lineBreaks: true,
  highlightSung: true,
  showSungHint: true,
  showBehind: true,
  liveStats: true,
  smoothCaret: true,
  backspaceFreedom: false,
  wpmBasis: "active",
  idleCap: 2,
  volume: 0.8,
  rate: 1,
  offset: 0,
  fontSize: 26,
  theme: "midnight",
};

let settings = { ...DEFAULTS, ...store("lt_settings", {}) };
for (const k of ["ttp", "strictAudio", "skipGaps", "gapThreshold", "lookahead"]) delete settings[k]; // removed "play as you type" mode
const saveSettings = () => storeSet("lt_settings", settings);

// keys that change the generated words or the test mode -> test must be rebuilt
const REBUILD_KEYS = new Set(["ignoreCase", "ignorePunct", "simplifyChars", "stripBrackets", "lineBreaks", "songOn"]);

const SCHEMA = [
  { group: "song", items: [
    { key: "songOn", type: "toggle", label: "song playback", desc: "turn off to type the lyrics in silence (no music, no sync)" },
    { key: "skipIntro", type: "toggle", label: "skip intro", desc: "start the song right before the first lyric" },
    { key: "endOnSongEnd", type: "toggle", label: "end test when the song ends", desc: "turn off to keep typing after the music stops (slow typists)" },
    { key: "finishOnAllTyped", type: "toggle", label: "finish when all lyrics are typed", desc: "show results as soon as the last word is done" },
    { key: "pauseOnBlur", type: "toggle", label: "pause when window loses focus" },
    { key: "volume", type: "range", label: "volume", min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
    { key: "rate", type: "seg", label: "playback speed", desc: "slow the song down if you can't keep up", options: [[0.5, "0.5×"], [0.75, "0.75×"], [0.9, "0.9×"], [1, "1×"], [1.1, "1.1×"], [1.25, "1.25×"]] },
    { key: "offset", type: "range", label: "lyrics offset", desc: "shift lyric timing if it feels early/late (+ = later)", min: -3, max: 3, step: 0.1, fmt: (v) => `${v > 0 ? "+" : ""}${Number(v).toFixed(1)}s` },
  ]},
  { group: "text", items: [
    { key: "ignoreCase", type: "toggle", label: "ignore case" },
    { key: "ignorePunct", type: "toggle", label: "ignore punctuation", desc: "strip commas, apostrophes, quotes…" },
    { key: "simplifyChars", type: "toggle", label: "simplify characters", desc: "é → e, curly quotes → straight quotes" },
    { key: "stripBrackets", type: "toggle", label: "remove bracketed text", desc: "drop ad-libs and tags like (ooh) or [chorus]" },
    { key: "lineBreaks", type: "toggle", label: "keep lyric line breaks", desc: "each lyric line starts on a new row" },
    { key: "backspaceFreedom", type: "toggle", label: "backspace into correct words", desc: "by default you can only go back into words with mistakes" },
  ]},
  { group: "display", items: [
    { key: "highlightSung", type: "toggle", label: "highlight the line being sung" },
    { key: "showSungHint", type: "toggle", label: "show the sung line above the text" },
    { key: "showBehind", type: "toggle", label: "show lines behind / ahead of the singer" },
    { key: "liveStats", type: "toggle", label: "live wpm & accuracy" },
    { key: "smoothCaret", type: "toggle", label: "smooth caret" },
    { key: "fontSize", type: "range", label: "font size", min: 16, max: 40, step: 1, fmt: (v) => `${v}px` },
    { key: "theme", type: "seg", label: "theme", options: [["midnight", "midnight"], ["paper", "paper"], ["forest", "forest"], ["rose", "rose"], ["ocean", "ocean"]] },
  ]},
  { group: "scoring", items: [
    { key: "wpmBasis", type: "seg", label: "wpm time basis", desc: "active: pauses longer than the idle cap don't count against you. total: whole test duration.", options: [["active", "active typing"], ["total", "total time"]] },
    { key: "idleCap", type: "range", label: "idle cap", desc: "max seconds a single pause can add to active time", min: 1, max: 10, step: 0.5, fmt: (v) => `${v}s` },
  ]},
];

function renderSettings() {
  renderSchema($("#settingsBody"), SCHEMA, settings, setSetting);
}

function setSetting(key, val) {
  if (settings[key] === val) return;
  settings[key] = val;
  saveSettings();
  applySettings();
  if (REBUILD_KEYS.has(key) && currentView === "test" && S.lines.length) {
    const wasStarted = S.started;
    resetTest();
    if (wasStarted) toast("test restarted to apply the setting");
  }
  if (key === "songOn" && val && !S.audioOk && S.track) toast("audio is still downloading…");
}

function applySettings() {
  document.documentElement.dataset.theme = settings.theme;
  $("#wordsWrap").style.setProperty("--fs", `${settings.fontSize}px`);
  $("#caret").classList.toggle("smooth", settings.smoothCaret);
  $("#sungHint").classList.toggle("hidden", !settings.showSungHint || !settings.songOn);
  $("#liveStats").classList.toggle("hidden", !settings.liveStats);
  $("#songProgress").style.display = settings.songOn ? "" : "none";
  const tg = $("#songToggle");
  tg.classList.toggle("on", settings.songOn);
  tg.innerHTML = settings.songOn ? "♪ song: on" : "✕ song: off";
  tg.title = settings.songOn ? "the song plays while you type — click to type in silence" : "typing in silence — click to play the song while typing";
  Player.setVolume(settings.volume);
  audio.defaultPlaybackRate = settings.rate;
  audio.playbackRate = settings.rate;
  if (!settings.highlightSung || !settings.songOn) $$(".word.sung").forEach((w) => w.classList.remove("sung"));
  S.sungIdx = -2;
  if (currentView === "test") requestAnimationFrame(() => { scrollWords(); placeCaret(); });
}

/* =====================================================================================
   audio player (Web Audio gain for click-free pause/resume)
   ===================================================================================== */
const audio = $("#audio");
const Player = {
  ctx: null, gain: null, want: false, timer: null, vol: 0.8,
  ensure() {
    if (!this.ctx) {
      try {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        const src = this.ctx.createMediaElementSource(audio);
        this.gain = this.ctx.createGain();
        this.gain.gain.value = this.vol;
        src.connect(this.gain).connect(this.ctx.destination);
        audio.volume = 1;
      } catch (e) { this.ctx = null; this.gain = null; }
    }
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume();
  },
  setVolume(v) {
    this.vol = v;
    if (this.gain) this.gain.gain.setTargetAtTime(this.want ? v : 0, this.ctx.currentTime, 0.01);
    else audio.volume = v;
  },
  play() {
    this.want = true;
    clearTimeout(this.timer);
    if (this.gain) {
      this.gain.gain.cancelScheduledValues(this.ctx.currentTime);
      this.gain.gain.setTargetAtTime(this.vol, this.ctx.currentTime, 0.012);
    }
    if (audio.paused) audio.play().catch(() => {});
  },
  pause(hard = false) {
    this.want = false;
    clearTimeout(this.timer);
    if (this.gain && !hard) {
      this.gain.gain.cancelScheduledValues(this.ctx.currentTime);
      this.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.012);
      this.timer = setTimeout(() => { if (!this.want) audio.pause(); }, 70);
    } else {
      audio.pause();
    }
  },
  seek(t) { try { audio.currentTime = Math.max(0, t); } catch {} },
};

/* =====================================================================================
   text processing
   ===================================================================================== */
function simplify(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").normalize("NFC")
    .replace(/[‘’ʼ`´′]/g, "'").replace(/[“”„″]/g, '"').replace(/[–—―]/g, "-")
    .replace(/…/g, "...").replace(/ /g, " ");
}

function processText(s) {
  if (settings.stripBrackets) s = s.replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, " ");
  if (settings.simplifyChars) s = simplify(s);
  if (settings.ignorePunct) s = s.replace(/[-_/\\|]/g, " ").replace(/[^\p{L}\p{N}\p{M}\s]/gu, "");
  if (settings.ignoreCase) s = s.toLowerCase();
  return s.replace(/\s+/g, " ").trim();
}

const eqChar = (a, b) => (settings.ignoreCase ? a.toLowerCase() === b.toLowerCase() : a === b);

/** builds S.words / S.tlines (typing lines) from S.lines (raw timed lines) */
function buildWords() {
  const raw = S.lines;
  const duration = songDuration();
  const words = [], tlines = [];
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (!line.text) continue;
    const toks = processText(line.text).split(" ").filter(Boolean);
    if (!toks.length) continue;
    let end = duration;
    for (let j = i + 1; j < raw.length; j++) if (raw[j].t > line.t) { end = raw[j].t; break; }
    const chars = toks.reduce((a, t) => a + [...t].length, 0) + toks.length - 1;
    const span = Math.max(0.4, Math.min(Math.max(0.4, end - line.t), chars * 0.09 + 1.2));
    const tl = { t: line.t, end, spanEnd: line.t + span, text: line.text, first: words.length, last: 0 };
    for (const tok of toks) words.push({ text: tok, chars: [...tok], line: tlines.length });
    tl.last = words.length - 1;
    tlines.push(tl);
  }
  S.words = words;
  S.tlines = tlines;
}

function songDuration() {
  return (isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0) || S.track?.duration || 240;
}

/* =====================================================================================
   state
   ===================================================================================== */
const S = {
  track: null, lyrics: null, lyricsResult: null, lines: [], synced: false, audioOk: false,
  words: [], tlines: [], typed: [], wi: 0, wordEls: [],
  started: false, finished: false, paused: false, withSong: false,
  t0: 0, pausedTotal: 0, pauseAt: 0, lastKey: 0, active: 0,
  totalKeys: 0, correctKeys: 0, errKeys: 0,
  sungIdx: -2, samples: [], secChars: 0, secErr: 0, sampleTimer: null,
  songEnded: false, scrollY: 0, loadToken: 0,
};

let currentView = "home";
function show(view) {
  currentView = view;
  for (const v of ["Home", "Loading", "Test", "Results", "History"]) $(`#view${v}`).classList.toggle("active", v.toLowerCase() === view);
  if (view !== "test" && view !== "results") Player.pause(true);
  if (view === "home") { renderHomeHistory(); setTimeout(() => $("#searchInput").focus(), 30); }
  if (view === "history") renderHistory();
  if (view === "test" && document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
}

/* =====================================================================================
   loading a track
   ===================================================================================== */
initSearch(selectTrack);

async function selectTrack(tr) {
  const token = ++S.loadToken;
  const waitAudio = settings.songOn;
  S.track = { ...tr };
  S.audioOk = false;
  audio.removeAttribute("src");
  show("loading");
  $("#loadThumb").src = tr.thumb || "";
  $("#loadThumb").style.display = tr.thumb ? "" : "none";
  $("#loadTitle").textContent = tr.title;
  $("#loadError").textContent = "";
  $("#stepAudio").style.display = waitAudio ? "" : "none";
  resetSteps();

  let res;
  try {
    res = await loadTrack(tr, { waitAudio, onStep: setStep });
  } catch (err) {
    if (token === S.loadToken) $("#loadError").textContent = err.message;
    return;
  }
  if (token !== S.loadToken) return;
  const { track, lyr, audioReady } = res;
  S.track = track;
  S.lyricsResult = lyr;
  audioReady.then((meta) => {
    if (token !== S.loadToken) return;
    Object.assign(S.track, meta);
    audio.src = `/api/audio/${tr.key}`;
    audio.load();
    S.audioOk = true;
  }).catch((e) => { if (token === S.loadToken && settings.songOn) toast(`audio failed: ${e.message}`); });
  if (waitAudio) await audioReady.catch(() => {});

  $("#songThumb").src = S.track.thumb || "";
  $("#songTitle").textContent = S.track.title;
  $("#listenLink").href = `listen.html?track=${encodeURIComponent(tr.key)}`;
  history.replaceState(null, "", `?track=${encodeURIComponent(tr.key)}`);
  show("test");
  if (lyr?.best) {
    setLyrics(lyr.best);
  } else {
    setLyrics(null);
    LyricsPicker.open("couldn't find lyrics automatically — search below or paste them.");
  }
}

$("#loadCancel").addEventListener("click", () => { S.loadToken++; show("home"); });

function setLyrics(l) {
  S.lyrics = l;
  const r = lyricsToLines(l, songDuration());
  S.lines = r.lines;
  S.synced = r.synced;
  $("#lyricsInfo").textContent = lyricsLabel(l, S.synced);
  resetTest();
}

LyricsPicker.init(() => ({ track: S.track, lyrics: S.lyrics, result: S.lyricsResult }), setLyrics);
$("#changeLyricsBtn").addEventListener("click", () => LyricsPicker.open());

audio.addEventListener("loadedmetadata", () => {
  // plain lyrics are spread over the song: redo once the real duration is known
  if (S.lyrics && !S.synced && !S.started && S.lyrics.plainLyrics) {
    S.lines = plainToLines(S.lyrics.plainLyrics, songDuration());
    resetTest();
  }
});

/* =====================================================================================
   test lifecycle
   ===================================================================================== */
function resetTest() {
  clearInterval(S.sampleTimer);
  Player.pause(true);
  Player.seek(0);
  Object.assign(S, {
    typed: [], wi: 0, started: false, finished: false, paused: false, withSong: false,
    t0: 0, pausedTotal: 0, pauseAt: 0, lastKey: 0, active: 0,
    totalKeys: 0, correctKeys: 0, errKeys: 0, sungIdx: -2,
    samples: [], secChars: 0, secErr: 0, songEnded: false, scrollY: 0,
  });
  buildWords();
  S.typed = S.words.map(() => []);
  renderWords();
  $("#pauseBtn").innerHTML = "❚❚ pause";
  $("#wordsWrap").classList.add("waiting");
  $("#wordsWrap").classList.remove("blurred");
  $("#lsWordsTotal").textContent = S.words.length;
  $("#sungNow").textContent = "";
  $("#sungNext").textContent = "";
  updateLive(true);
  requestAnimationFrame(() => { scrollWords(); placeCaret(); });
}

function startTest() {
  if (!S.words.length) return;
  S.started = true;
  S.t0 = now();
  S.lastKey = S.t0;
  $("#wordsWrap").classList.remove("waiting");
  S.withSong = settings.songOn && S.audioOk;
  if (settings.songOn && !S.audioOk) toast("audio not ready yet — typing without the song");
  if (S.withSong) {
    Player.ensure();
    const first = S.tlines[0].t + settings.offset;
    Player.seek(settings.skipIntro && first > 3 ? first - 2 : 0);
    Player.play();
  }
  S.sampleTimer = setInterval(sampleSecond, 1000);
}

function elapsed() {
  if (!S.started) return 0;
  const end = S.finished ? S.finishedAt : now();
  const paused = S.pausedTotal + (S.paused ? end - S.pauseAt : 0);
  return Math.max(0, (end - S.t0 - paused) / 1000);
}

function setPaused(p) {
  if (!S.started || S.finished || S.paused === p) return;
  S.paused = p;
  if (p) {
    S.pauseAt = now();
    if (S.withSong) Player.pause();
    $("#pauseBtn").innerHTML = "▶ resume";
  } else {
    S.pausedTotal += now() - S.pauseAt;
    S.lastKey = now();
    if (S.withSong && !S.songEnded) Player.play();
    $("#pauseBtn").innerHTML = "❚❚ pause";
  }
}

function finish(reason) {
  if (!S.started || S.finished) return;
  if (S.paused) setPaused(false);
  S.finishedAt = now();
  S.finished = true;
  S.reason = reason;
  clearInterval(S.sampleTimer);
  sampleSecond(true);
  Player.pause();
  showResults();
}

/* =====================================================================================
   typing
   ===================================================================================== */
function onKey(e) {
  if (currentView === "results") {
    if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); $("#retryBtn").click(); }
    return;
  }
  if (currentView !== "test" || $(".modal.open")) return;
  const tag = document.activeElement?.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

  $("#wordsWrap").classList.remove("blurred");

  if (e.key === "Escape") {
    e.preventDefault();
    if (S.started) finish("stopped");
    return;
  }
  if (e.key === "Tab") { e.preventDefault(); resetTest(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") { e.preventDefault(); setPaused(!S.paused); return; }
  if (!S.words.length || S.finished) return;

  if (e.key === "Backspace") {
    e.preventDefault();
    if (!S.started) return;
    backspace(e.ctrlKey || e.altKey || e.metaKey);
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (e.key === " " || e.key === "Enter") {
    e.preventDefault();
    if (!S.started) return;
    if (S.paused) setPaused(false);
    nextWord();
    return;
  }
  if (e.key.length !== 1 && [...e.key].length !== 1) return;
  e.preventDefault();
  if (!S.started) startTest();
  if (S.paused) setPaused(false);
  typeChar(e.key);
}
document.addEventListener("keydown", onKey);

function registerKey(correct) {
  const t = now();
  S.active += Math.min((t - S.lastKey) / 1000, settings.idleCap);
  S.lastKey = t;
  S.totalKeys++;
  S.secChars++;
  if (correct) S.correctKeys++;
  else { S.errKeys++; S.secErr++; }
}

function typeChar(ch) {
  if (S.wi >= S.words.length) return;
  const wi = S.wi, w = S.words[wi], t = S.typed[wi];
  if (t.length >= w.chars.length + 15) return; // cap extra letters
  const exp = w.chars[t.length];
  registerKey(exp !== undefined && eqChar(ch, exp));
  t.push(ch);
  renderWord(wi);
  afterInput();
  // auto-finish when the last word is typed exactly
  if (wi === S.words.length - 1 && t.length === w.chars.length && wordCorrect(wi)) {
    S.wi++;
    allWordsDone();
  }
}

function nextWord() {
  if (S.wi >= S.words.length) return;
  const wi = S.wi;
  if (!S.typed[wi].length) return; // ignore leading spaces
  registerKey(wordCorrect(wi));
  S.wi++;
  renderWord(wi);
  if (S.wi >= S.words.length) return allWordsDone();
  afterInput();
}

function backspace(wholeWord) {
  if (S.wi >= S.words.length) { S.wi = S.words.length - 1; renderWord(S.wi); }
  let wi = S.wi;
  if (!S.typed[wi].length) {
    if (wi === 0) return;
    if (wordCorrect(wi - 1) && !settings.backspaceFreedom) return;
    S.wi = --wi;
    renderWord(wi + 1);
    if (!wholeWord) { renderWord(wi); afterInput(); return; }
  }
  if (wholeWord) S.typed[wi] = [];
  else S.typed[wi].pop();
  renderWord(wi);
  afterInput();
}

function wordCorrect(i) {
  const w = S.words[i].chars, t = S.typed[i];
  if (t.length !== w.length) return false;
  for (let k = 0; k < w.length; k++) if (!eqChar(t[k], w[k])) return false;
  return true;
}

function afterInput() {
  scrollWords();
  placeCaret();
  $("#caret").classList.remove("idle");
  clearTimeout(S.idleT);
  S.idleT = setTimeout(() => $("#caret").classList.add("idle"), 800);
}

function allWordsDone() {
  placeCaret();
  if (!S.withSong || settings.finishOnAllTyped || S.songEnded) finish("completed");
  else toast("all lyrics typed — the song keeps playing, press esc for results");
}

/* =====================================================================================
   rendering of words / caret
   ===================================================================================== */
function renderWords() {
  const box = $("#words");
  box.innerHTML = "";
  S.wordEls = [];
  if (!S.words.length) {
    box.innerHTML = `<div class="empty">no lyrics loaded — use “change lyrics” to search or paste them.</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  S.words.forEach((w, i) => {
    if (settings.lineBreaks && i > 0 && w.line !== S.words[i - 1].line) {
      const br = document.createElement("div");
      br.className = "lbr";
      frag.appendChild(br);
    }
    const el = document.createElement("div");
    el.className = "word";
    el.innerHTML = w.chars.map((c) => `<span class="l">${esc(c)}</span>`).join("");
    S.wordEls.push(el);
    frag.appendChild(el);
  });
  box.appendChild(frag);
  box.style.transform = "translateY(0)";
}

function renderWord(i) {
  const el = S.wordEls[i];
  if (!el) return;
  const w = S.words[i].chars, t = S.typed[i];
  let html = "";
  const n = Math.max(w.length, t.length);
  for (let k = 0; k < n; k++) {
    if (k < w.length) {
      const cls = k < t.length ? (eqChar(t[k], w[k]) ? "ok" : "bad") : "";
      html += `<span class="l ${cls}">${esc(w[k])}</span>`;
    } else {
      html += `<span class="l extra">${esc(t[k])}</span>`;
    }
  }
  el.innerHTML = html;
  const done = i < S.wi;
  el.classList.toggle("typed", done);
  el.classList.toggle("error", done && !wordCorrect(i));
}

const lineHeightPx = () => settings.fontSize * 1.6;

function scrollWords() {
  const el = S.wordEls[Math.min(S.wi, S.wordEls.length - 1)];
  if (!el) return;
  const lh = lineHeightPx();
  const row = Math.round(el.offsetTop / lh);
  const y = Math.max(0, (row - 1) * lh);
  if (y !== S.scrollY) {
    S.scrollY = y;
    $("#words").style.transform = `translateY(${-y}px)`;
  }
}

function placeCaret() {
  const caret = $("#caret");
  const idx = Math.min(S.wi, S.wordEls.length - 1);
  const el = S.wordEls[idx];
  if (!el) { caret.style.display = "none"; return; }
  caret.style.display = "";
  const letters = el.children;
  const n = S.wi >= S.words.length ? letters.length : S.typed[idx].length;
  let x;
  if (n < letters.length) x = el.offsetLeft + letters[n].offsetLeft;
  else { const last = letters[letters.length - 1]; x = el.offsetLeft + last.offsetLeft + last.offsetWidth; }
  const lh = lineHeightPx();
  const ch = settings.fontSize * 1.15;
  caret.style.left = `${x - 1}px`;
  caret.style.top = `${el.offsetTop - S.scrollY + (lh - ch) / 2}px`;
}

window.addEventListener("resize", () => { if (currentView === "test") { scrollWords(); placeCaret(); } });

/* =====================================================================================
   main loop: sung line, live stats
   ===================================================================================== */
function tick() {
  if (currentView === "test" && S.started && !S.finished) {
    if (S.withSong) updateSung();
    if (now() - (S.lastLive || 0) > 200) updateLive();
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

function updateSung() {
  const lt = audio.currentTime - settings.offset;
  let idx = -1;
  for (let i = 0; i < S.tlines.length; i++) {
    if (S.tlines[i].t <= lt) idx = i; else break;
  }
  if (idx >= 0 && lt > S.tlines[idx].spanEnd + 1.5) idx = -1;
  if (idx === S.sungIdx) return;
  const prev = S.sungIdx;
  S.sungIdx = idx;
  if (settings.highlightSung) {
    if (prev >= 0 && S.tlines[prev]) for (let i = S.tlines[prev].first; i <= S.tlines[prev].last; i++) S.wordEls[i]?.classList.remove("sung");
    if (idx >= 0) for (let i = S.tlines[idx].first; i <= S.tlines[idx].last; i++) S.wordEls[i]?.classList.add("sung");
  }
  const nextIdx = idx >= 0 ? idx + 1 : S.tlines.findIndex((l) => l.t > lt);
  $("#sungNow").textContent = idx >= 0 ? `♪ ${S.tlines[idx].text}` : "♪ …";
  $("#sungNext").textContent = nextIdx >= 0 && S.tlines[nextIdx] ? S.tlines[nextIdx].text : "";
}

function counts() {
  let correct = 0, incorrect = 0, extra = 0, missed = 0, spaces = 0, wordChars = 0, wordsOk = 0;
  const last = Math.min(S.wi, S.words.length - 1);
  for (let i = 0; i <= last; i++) {
    const w = S.words[i].chars, t = S.typed[i];
    const partial = i >= S.wi;
    if (partial && !t.length) break;
    let ok = true;
    for (let k = 0; k < t.length; k++) {
      if (k >= w.length) { extra++; ok = false; }
      else if (eqChar(t[k], w[k])) correct++;
      else { incorrect++; ok = false; }
    }
    if (!partial) {
      spaces++;
      if (t.length < w.length) { missed += w.length - t.length; ok = false; }
      if (ok) { wordChars += w.length + 1; wordsOk++; }
    } else if (ok) {
      wordChars += t.length;
    }
  }
  return { correct, incorrect, extra, missed, spaces, wordChars, wordsOk, typed: correct + incorrect + extra + spaces };
}

function minutesBasis() {
  const total = elapsed();
  const active = Math.min(total, S.active + (S.started && !S.finished && !S.paused ? Math.min((now() - S.lastKey) / 1000, settings.idleCap) : 0));
  return { total, active, basis: settings.wpmBasis === "total" ? total : active };
}

function updateLive(reset) {
  S.lastLive = now();
  const tm = minutesBasis();
  const c = counts();
  const mins = tm.basis / 60;
  $("#lsTime").textContent = reset ? fmtTime(0) : fmtTime(tm.total);
  $("#lsWpm").textContent = Math.round(mins > 0.02 ? c.wordChars / 5 / mins : 0);
  $("#lsAcc").textContent = S.totalKeys ? Math.round((S.correctKeys / S.totalKeys) * 100) : 100;
  $("#lsWords").textContent = Math.min(S.wi, S.words.length);
  $("#songProgress").style.width = `${S.withSong ? Math.min(100, (audio.currentTime / songDuration()) * 100) : 0}%`;
  $("#typeProgress").style.width = `${S.words.length ? (Math.min(S.wi, S.words.length) / S.words.length) * 100 : 0}%`;
  const beh = $("#lsBehind");
  if (settings.showBehind && S.withSong && S.sungIdx >= 0 && S.words[S.wi]) {
    const d = S.sungIdx - S.words[S.wi].line;
    beh.textContent = d > 0 ? `${d} line${d > 1 ? "s" : ""} behind the singer` : d < 0 ? `${-d} line${d < -1 ? "s" : ""} ahead` : "on beat ♪";
  } else beh.textContent = "";
}

function sampleSecond(final) {
  if (!S.started || (S.paused && !final)) return;
  const tm = minutesBasis();
  const c = counts();
  const mins = tm.basis / 60;
  S.samples.push({ t: tm.total, wpm: mins > 0.02 ? c.wordChars / 5 / mins : 0, raw: S.secChars * 12, err: S.secErr });
  S.secChars = 0;
  S.secErr = 0;
}

audio.addEventListener("ended", () => {
  S.songEnded = true;
  if (currentView !== "test" || !S.started || S.finished || !S.withSong) return;
  if (settings.endOnSongEnd) finish("song ended");
  else toast("the song ended — keep typing, press esc for results");
});

/* =====================================================================================
   results
   ===================================================================================== */
function showResults() {
  const tm = minutesBasis();
  const c = counts();
  const mins = tm.basis / 60;
  const wpm = mins > 0 ? c.wordChars / 5 / mins : 0;
  const raw = mins > 0 ? c.typed / 5 / mins : 0;
  const wpmTotal = tm.total > 0 ? c.wordChars / 5 / (tm.total / 60) : 0;
  const acc = S.totalKeys ? (S.correctKeys / S.totalKeys) * 100 : 0;
  const raws = S.samples.map((s) => s.raw).filter((x) => x > 0);
  let consistency = 0;
  if (raws.length > 1) {
    const mean = raws.reduce((a, b) => a + b, 0) / raws.length;
    const sd = Math.sqrt(raws.reduce((a, b) => a + (b - mean) ** 2, 0) / raws.length);
    consistency = Math.max(0, 100 * (1 - sd / mean));
  }
  const done = Math.min(S.wi, S.words.length);
  const progress = S.words.length ? (done / S.words.length) * 100 : 0;
  const mode = S.withSong ? "with song" : "silent";

  const hist = loadHistory();
  const prevBest = hist.filter((h) => h.key === S.track?.key && h.mode === mode).reduce((m, h) => Math.max(m, h.wpm), 0);
  const isPb = wpm > prevBest && done >= 5;

  $("#rWpm").innerHTML = `${Math.round(wpm)}${isPb ? ` <span class="pb" title="personal best for this song">★</span>` : ""}`;
  $("#rAcc").textContent = `${Math.round(acc)}%`;
  const item = (label, value, title = "") => `<div class="r-item" title="${esc(title)}"><div class="label">${label}</div><div class="value">${value}</div></div>`;
  $("#rGrid").innerHTML = [
    item("raw", Math.round(raw), "all typed characters, incl. mistakes"),
    item("wpm (total time)", Math.round(wpmTotal), "net wpm over the whole test duration"),
    item("characters", `${c.correct}<small>/</small>${c.incorrect}<small>/</small>${c.extra}<small>/</small>${c.missed}`, "correct / incorrect / extra / missed"),
    item("consistency", `${Math.round(consistency)}%`),
    item("time", `${fmtTime(tm.total)}<small> (${fmtTime(tm.active)} active)</small>`),
    item("words", `${c.wordsOk}<small>/${done} ok</small>`),
    item("lyrics typed", `${Math.round(progress)}%`),
    S.withSong ? item("song heard", `${Math.round(Math.min(100, (audio.currentTime / songDuration()) * 100))}%`) : "",
    item("mode", `<small>${mode}${S.withSong && settings.rate !== 1 ? ` · ${settings.rate}×` : ""}</small>`),
    item("ended", `<small>${esc(S.reason)}</small>`),
  ].join("");
  $("#rSong").innerHTML = `<b>${esc(S.track?.title || "")}</b>${S.lyrics?.trackName ? ` · lyrics: ${esc([S.lyrics.artistName, S.lyrics.trackName].filter(Boolean).join(" – "))}` : ""}
    ${isPb ? `<br><span class="pb">★ new personal best for this song (${mode})${prevBest ? ` — previous ${Math.round(prevBest)} wpm` : ""}</span>` : prevBest ? `<br>personal best: ${Math.round(prevBest)} wpm` : ""}`;

  if (S.totalKeys > 0) {
    addHistory({
      ts: Date.now(), key: S.track?.key, title: S.track?.title, mode,
      wpm: Math.round(wpm * 10) / 10, raw: Math.round(raw), acc: Math.round(acc * 10) / 10,
      progress: Math.round(progress), time: Math.round(tm.total), reason: S.reason,
    });
  }
  show("results");
  requestAnimationFrame(() => drawChart(S.samples));
}

function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }

function drawChart(samples) {
  const cv = $("#chart");
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext("2d");
  g.scale(dpr, dpr);
  g.clearRect(0, 0, W, H);
  const sub = cssVar("--sub"), main = cssVar("--main"), err = cssVar("--error");
  g.font = "11px JetBrains Mono, monospace";
  if (samples.length < 2) {
    g.fillStyle = sub;
    g.fillText("not enough data for a chart", 10, H / 2);
    return;
  }
  const smooth = samples.map((s, i) => {
    const win = samples.slice(Math.max(0, i - 2), i + 1);
    return win.reduce((a, b) => a + b.raw, 0) / win.length;
  });
  const maxY = Math.max(10, ...samples.map((s) => s.wpm), ...smooth) * 1.15;
  const maxErr = Math.max(1, ...samples.map((s) => s.err));
  const L = 36, R = 30, T = 10, B = 22;
  const x = (i) => L + ((W - L - R) * i) / (samples.length - 1);
  const y = (v) => T + (H - T - B) * (1 - v / maxY);
  g.strokeStyle = sub + "40"; g.fillStyle = sub; g.lineWidth = 1;
  for (let k = 0; k <= 4; k++) {
    const v = (maxY / 4) * k;
    g.beginPath(); g.moveTo(L, y(v)); g.lineTo(W - R, y(v)); g.stroke();
    g.fillText(String(Math.round(v)), 4, y(v) + 4);
  }
  const step = Math.max(1, Math.ceil(samples.length / 10));
  let lastLab = "";
  for (let i = 0; i < samples.length; i += step) {
    const lab = fmtTime(samples[i].t);
    if (lab !== lastLab) g.fillText(lab, x(i) - 12, H - 5);
    lastLab = lab;
  }
  g.save(); g.translate(W - 6, T + 40); g.rotate(Math.PI / 2); g.fillText("errors", 0, 0); g.restore();

  const line = (vals, color, width) => {
    g.strokeStyle = color; g.lineWidth = width; g.lineJoin = "round"; g.beginPath();
    vals.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v))));
    g.stroke();
  };
  line(smooth, sub, 2);
  line(samples.map((s) => s.wpm), main, 3);
  g.strokeStyle = err; g.lineWidth = 2;
  samples.forEach((s, i) => {
    if (!s.err) return;
    const yy = T + (H - T - B) * (1 - s.err / maxErr) * 0.9 + 4, xx = x(i), r = 3;
    g.beginPath(); g.moveTo(xx - r, yy - r); g.lineTo(xx + r, yy + r); g.moveTo(xx + r, yy - r); g.lineTo(xx - r, yy + r); g.stroke();
  });
  const lx = W - R - 170, ly = H - B - 8;
  g.fillStyle = main; g.fillRect(lx, ly - 4, 10, 3); g.fillStyle = sub; g.fillText("wpm", lx + 14, ly);
  g.fillStyle = sub; g.fillRect(lx + 50, ly - 4, 10, 3); g.fillText("raw", lx + 64, ly);
  g.fillStyle = err; g.fillText("× errors", lx + 100, ly);
}

window.addEventListener("resize", () => { if (currentView === "results") drawChart(S.samples); });

$("#retryBtn").addEventListener("click", () => { show("test"); resetTest(); });
$("#newSongBtn").addEventListener("click", () => show("home"));

/* =====================================================================================
   history
   ===================================================================================== */
const loadHistory = () => store("lt_history", []);
function addHistory(h) {
  const list = loadHistory();
  list.unshift(h);
  storeSet("lt_history", list.slice(0, 300));
}

function histTable(list) {
  if (!list.length) return `<div class="empty">no tests yet — search for a song and start typing.</div>`;
  const tracks = loadTracks();
  return `<table class="hist-table"><tr><th>song</th><th>wpm</th><th>raw</th><th>acc</th><th>typed</th><th>mode</th><th>when</th><th></th></tr>
  ${list.map((h) => `<tr><td class="song" title="${esc(h.title || "")}">${esc(h.title || "?")}</td>
    <td class="num">${Math.round(h.wpm)}</td><td class="num">${h.raw ?? ""}</td><td class="num">${Math.round(h.acc)}%</td>
    <td>${h.progress ?? ""}%</td><td>${esc(h.mode)}</td><td>${new Date(h.ts).toLocaleString()}</td>
    <td>${tracks[h.key] ? `<button class="link" data-play="${esc(h.key)}">play again</button>` : ""}</td></tr>`).join("")}</table>`;
}

function bindPlayAgain(root) {
  const tracks = loadTracks();
  $$("[data-play]", root).forEach((b) => b.addEventListener("click", () => selectTrack(tracks[b.dataset.play])));
}

function renderHomeHistory() {
  const list = loadHistory().slice(0, 6);
  const box = $("#homeHistory");
  box.innerHTML = list.length ? `<h2>recent tests</h2>${histTable(list)}` : "";
  bindPlayAgain(box);
}
function renderHistory() {
  const box = $("#historyList");
  box.innerHTML = histTable(loadHistory());
  bindPlayAgain(box);
}
$("#clearHistoryBtn").addEventListener("click", () => {
  if (!confirm("clear all test history?")) return;
  storeSet("lt_history", []);
  renderHistory();
});

/* =====================================================================================
   misc ui
   ===================================================================================== */
const goHome = () => { history.replaceState(null, "", location.pathname); show("home"); };
$("#navSettings").addEventListener("click", () => { renderSettings(); openModal("#settingsModal"); });
$("#navSearch").addEventListener("click", goHome);
$("#navHistory").addEventListener("click", () => show("history"));
$("#logoBtn").addEventListener("click", (e) => { e.preventDefault(); goHome(); });
$("#resetSettingsBtn").addEventListener("click", () => {
  const rebuild = [...REBUILD_KEYS].some((k) => settings[k] !== DEFAULTS[k]);
  settings = { ...DEFAULTS };
  saveSettings();
  applySettings();
  renderSettings();
  if (rebuild && currentView === "test" && S.lines.length) resetTest();
});

$("#songToggle").addEventListener("click", () => setSetting("songOn", !settings.songOn));
$("#pauseBtn").addEventListener("click", () => {
  if (!S.started) return toast("start typing first");
  setPaused(!S.paused);
});
$("#stopBtn").addEventListener("click", () => {
  if (!S.started) return toast("nothing typed yet");
  finish("stopped");
});
$("#restartBtn").addEventListener("click", () => resetTest());
$("#focusOverlay").addEventListener("click", () => $("#wordsWrap").classList.remove("blurred"));
// "listen only" keeps the current song when one is loaded
$("#listenFooter").addEventListener("click", (e) => {
  if (S.track?.key && currentView !== "home") e.currentTarget.href = `listen.html?track=${encodeURIComponent(S.track.key)}`;
});

// don't let clicked buttons keep focus (space would re-trigger them while typing)
document.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b && currentView === "test") b.blur();
});

window.addEventListener("blur", () => {
  if (currentView !== "test") return;
  $("#wordsWrap").classList.add("blurred");
  if (settings.pauseOnBlur && S.started && !S.finished) setPaused(true);
});

applySettings();
const fromQuery = trackFromQuery();
if (fromQuery) selectTrack(fromQuery);
else show("home");
