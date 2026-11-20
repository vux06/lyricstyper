"""LyricsTyper backend.

- /api/search        search YouTube / SoundCloud through yt-dlp
- /api/prepare/{key} download the audio of a search result into ./cache/audio
- /api/audio/{key}   stream the cached audio (supports HTTP range requests)
- /api/lyrics        look up (synced) lyrics on LRCLIB, falling back to lyrics.ovh
- /api/lyrics/id/{n} fetch one LRCLIB record by id
"""

from __future__ import annotations

import asyncio
import difflib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any

import httpx
import yt_dlp
from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

import auth

ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
CACHE = ROOT / "cache"
AUDIO_DIR = CACHE / "audio"
AUDIO_DIR.mkdir(parents=True, exist_ok=True)
INDEX_FILE = CACHE / "index.json"
MAX_CACHED_TRACKS = 60

UA = "LyricsTyper/1.0 (local typing practice app)"
LRCLIB = "https://lrclib.net/api"
LYRICS_OVH = "https://api.lyrics.ovh/v1"

app = FastAPI(title="LyricsTyper")
auth.install(app, STATIC)

# --------------------------------------------------------------------------------------
# Track registry: key -> {url, title, channel, duration, thumb, source}
# --------------------------------------------------------------------------------------
_reg_lock = threading.Lock()


def _load_index() -> dict[str, dict[str, Any]]:
    try:
        return json.loads(INDEX_FILE.read_text())
    except Exception:
        return {}


REGISTRY: dict[str, dict[str, Any]] = _load_index()


def _save_index() -> None:
    tmp = INDEX_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(REGISTRY))
    tmp.replace(INDEX_FILE)


def key_for(url: str) -> str:
    return hashlib.sha1(url.encode()).hexdigest()[:16]


def register(entry: dict[str, Any]) -> dict[str, Any]:
    key = key_for(entry["url"])
    entry["key"] = key
    with _reg_lock:
        old = REGISTRY.get(key, {})
        REGISTRY[key] = {**old, **{k: v for k, v in entry.items() if v is not None}}
        _save_index()
    return REGISTRY[key]


def cached_audio(key: str) -> Path | None:
    for p in AUDIO_DIR.glob(f"{key}.*"):
        if p.suffix in (".part", ".ytdl", ".tmp") or ".part" in p.name:
            continue
        return p
    return None


def prune_cache() -> None:
    files = sorted(
        (p for p in AUDIO_DIR.iterdir() if p.is_file()), key=lambda p: p.stat().st_atime
    )
    for p in files[:-MAX_CACHED_TRACKS] if len(files) > MAX_CACHED_TRACKS else []:
        try:
            p.unlink()
        except OSError:
            pass


# --------------------------------------------------------------------------------------
# Search
# --------------------------------------------------------------------------------------
SEARCH_PREFIX = {"youtube": "ytsearch", "soundcloud": "scsearch"}
URL_RE = re.compile(r"^https?://", re.I)


def _thumb(e: dict[str, Any]) -> str | None:
    vid = e.get("id")
    if e.get("ie_key") == "Youtube" or (
        isinstance(vid, str) and len(vid) == 11 and "youtube" in (e.get("url") or "youtube")
    ):
        return f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg"
    if e.get("thumbnail"):
        return e["thumbnail"]
    thumbs = e.get("thumbnails") or []
    return thumbs[-1].get("url") if thumbs else None


def _search_sync(q: str, source: str, n: int) -> list[dict[str, Any]]:
    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
    }
    if URL_RE.match(q):
        opts["extract_flat"] = "in_playlist"
        target = q
    else:
        prefix = SEARCH_PREFIX.get(source, "ytsearch")
        # SoundCloud's flat results lack titles, so resolve them fully (still quick).
        if source != "soundcloud":
            opts["extract_flat"] = "in_playlist"
        target = f"{prefix}{n}:{q}"

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(target, download=False)
    except Exception:
        if not (PROXY and (source == "youtube" or "youtu" in q)):
            raise
        with yt_dlp.YoutubeDL({**opts, "proxy": PROXY}) as ydl:  # blocked: go through WARP
            info = ydl.extract_info(target, download=False)

    entries = info.get("entries") if info.get("entries") is not None else [info]
    results = []
    for e in entries:
        if not e:
            continue
        url = e.get("webpage_url") or e.get("url")
        if not url:
            continue
        if not URL_RE.match(url) and e.get("id"):
            url = f"https://www.youtube.com/watch?v={e['id']}"
        if e.get("live_status") in ("is_live", "is_upcoming"):
            continue
        entry = register(
            {
                "url": url,
                "title": e.get("title") or url,
                "channel": e.get("channel") or e.get("uploader") or "",
                "duration": e.get("duration"),
                "thumb": _thumb(e),
                "source": source if not URL_RE.match(q) else (e.get("extractor_key") or "url"),
                "artist": e.get("artist"),
                "track": e.get("track"),
            }
        )
        results.append(entry)
    return results


_search_cache: dict[tuple[str, str], tuple[float, list[dict[str, Any]]]] = {}


@app.get("/api/search")
async def search(
    q: str = Query(..., min_length=1, max_length=300),
    source: str = Query("youtube"),
    n: int = Query(12, ge=1, le=25),
):
    ck = (q.strip().lower(), source)
    hit = _search_cache.get(ck)
    if hit and time.time() - hit[0] < 600:
        return {"results": hit[1]}
    try:
        results = await asyncio.to_thread(_search_sync, q.strip(), source, n)
    except Exception as exc:  # yt-dlp raises many error types
        raise HTTPException(502, f"Search failed: {exc}") from exc
    _search_cache[ck] = (time.time(), results)
    return {"results": results}


# --------------------------------------------------------------------------------------
# Download / audio
# --------------------------------------------------------------------------------------
_dl_locks: dict[str, asyncio.Lock] = {}


YTDLP_BIN = shutil.which("yt-dlp", path=str(Path(sys.executable).parent)) or shutil.which("yt-dlp")
META_TMPL = "%(.{title,channel,uploader,duration,artist,creator,track,album})j"


# Optional cookies for YouTube (Netscape cookies.txt). Datacenter IPs often get
# "Sign in to confirm you're not a bot"; cookies from a (throwaway) account fix that.
COOKIES = Path(os.environ.get("YTDLP_COOKIES", CACHE / "youtube-cookies.txt"))
# e.g. socks5://127.0.0.1:40000 (Cloudflare WARP in proxy mode) for YouTube from a datacenter IP
PROXY = os.environ.get("YTDLP_PROXY", "").strip()
BOT_RE = re.compile(r"not a bot|sign in to confirm|HTTP Error 429|cookies", re.I)


def _ytdlp_get(key: str, url: str) -> dict[str, Any]:
    """Download directly; if YouTube blocks this IP, retry once through the proxy (WARP)."""
    try:
        return _ytdlp_get_once(key, url, proxy=False)
    except RuntimeError as exc:
        if PROXY and "youtu" in url and BOT_RE.search(str(exc)):
            return _ytdlp_get_once(key, url, proxy=True)
        raise


def _ytdlp_get_once(key: str, url: str, proxy: bool) -> dict[str, Any]:
    """Download one URL's best audio to AUDIO_DIR/key.*; returns yt-dlp metadata or raises."""
    cmd = [
        YTDLP_BIN or "yt-dlp",
        "--no-playlist", "--no-progress", "--no-warnings", "--no-simulate",
        "-f", "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/best",
        "-o", str(AUDIO_DIR / f"{key}.%(ext)s"),
        "--print", f"after_move:{META_TMPL}",
    ]
    if "youtu" in url:
        if COOKIES.is_file():
            cmd += ["--cookies", str(COOKIES)]
        if proxy:
            cmd += ["--proxy", PROXY]
    cmd.append(url)
    last_err = "unknown error"
    for attempt in range(3):
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if proc.returncode == 0 and cached_audio(key):
            for line in reversed(proc.stdout.strip().splitlines()):
                try:
                    return json.loads(line)
                except ValueError:
                    continue
            return {}
        last_err = ((proc.stderr or proc.stdout).strip().splitlines() or ["unknown error"])[-1]
        for f in AUDIO_DIR.glob(f"{key}.*"):  # drop partial files before retrying
            f.unlink(missing_ok=True)
        if BOT_RE.search(last_err):  # retrying won't help
            break
        time.sleep(1 + attempt)
    raise RuntimeError(last_err)


def _soundcloud_match(entry: dict[str, Any]) -> str | None:
    """Find the same song on SoundCloud (used when YouTube refuses this server)."""
    artist, track = clean_title(entry.get("title") or "", entry.get("channel"))
    query = f"{artist} {track}".strip()
    if not query:
        return None
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "skip_download": True}) as ydl:
        info = ydl.extract_info(f"scsearch6:{query}", download=False)
    want_dur = entry.get("duration") or 0
    want, who_want = _norm(track), _norm(artist)
    orig = _norm(entry.get("title") or "")
    best, best_score = None, -1e9
    for e in info.get("entries") or []:
        if not e or not e.get("webpage_url"):
            continue
        name = _norm(e.get("title") or "")
        uploader = _norm(e.get("uploader") or "")
        dur = e.get("duration") or 0
        # only the artist's own upload of the full track counts (no covers, previews or edits)
        if not who_want or who_want not in uploader or dur < 60:
            continue
        if any(b in name and b not in orig for b in ("cover", "remix", "karaoke", "instrumental", "nightcore", "sped up", "slowed", "edit", "live", "acoustic", "flip", "bootleg", "mashup", "rework")):
            continue
        score = difflib.SequenceMatcher(None, want, name).ratio() * 10 + (5 if want and want in name else 0)
        if want_dur:
            score -= min(abs(dur - want_dur), 120) / 12
        if score > best_score:
            best, best_score = e, score
    return best["webpage_url"] if best and best_score > 2 else None


def _download_sync(key: str) -> dict[str, Any]:
    """Download best audio with the yt-dlp CLI (more reliable than in-process for YouTube)."""
    entry = REGISTRY[key]
    extra: dict[str, Any] = {}
    try:
        info = _ytdlp_get(key, entry["url"])
        with _reg_lock:
            REGISTRY[key].pop("audio_from", None)
    except RuntimeError as exc:
        if "youtu" not in entry["url"]:
            raise
        alt = _soundcloud_match(entry)
        if not alt:
            raise RuntimeError(
                "YouTube is blocking downloads from this server and the song isn't on SoundCloud. "
                "Try the soundcloud source, or add YouTube cookies (see README)."
            ) from exc
        info = _ytdlp_get(key, alt)
        # keep the YouTube title for the lyrics lookup, but use the real audio length
        info = {"duration": info.get("duration")}
        extra = {"audio_from": alt}
    return register(
        {
            "url": entry["url"],
            "title": info.get("title"),
            "channel": info.get("channel") or info.get("uploader"),
            "duration": info.get("duration"),
            "artist": info.get("artist") or info.get("creator"),
            "track": info.get("track"),
            "album": info.get("album"),
            **extra,
        }
    )


@app.post("/api/prepare/{key}")
async def prepare(key: str, url: str | None = None):
    if key not in REGISTRY:
        # e.g. the cache was wiped but the browser still remembers the track
        if url and URL_RE.match(url) and key_for(url) == key:
            register({"url": url, "title": url})
        else:
            raise HTTPException(404, "Unknown track - search for it again.")
    lock = _dl_locks.setdefault(key, asyncio.Lock())
    async with lock:
        if not cached_audio(key):
            try:
                await asyncio.to_thread(_download_sync, key)
            except Exception as exc:
                raise HTTPException(502, f"Download failed: {exc}") from exc
            await asyncio.to_thread(prune_cache)
    path = cached_audio(key)
    if not path:
        raise HTTPException(500, "Download finished but no audio file was found.")
    return {**REGISTRY[key], "ext": path.suffix.lstrip(".")}


MEDIA_TYPES = {
    ".m4a": "audio/mp4",
    ".mp4": "video/mp4",
    ".webm": "audio/webm",
    ".opus": "audio/ogg",
    ".ogg": "audio/ogg",
    ".mp3": "audio/mpeg",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".wav": "audio/wav",
}


@app.get("/api/audio/{key}")
async def audio(key: str):
    if not re.fullmatch(r"[0-9a-f]{16}", key):
        raise HTTPException(400, "Bad key")
    path = cached_audio(key)
    if not path:
        raise HTTPException(404, "Audio not downloaded yet")
    return FileResponse(path, media_type=MEDIA_TYPES.get(path.suffix, "application/octet-stream"))


# --------------------------------------------------------------------------------------
# Lyrics
# --------------------------------------------------------------------------------------
_JUNK_WORDS = (
    r"official|video|audio|lyrics?|visuali[sz]er|hd|hq|4k|remaster(?:ed)?|m/?v|explicit|clean"
    r"|color coded|full song|performance|music|clip|vevo|topic|eng sub|sub|letra|tradu[cç][aã]o"
)
_JUNK_BRACKET = re.compile(rf"\s*[\(\[\{{【][^\)\]\}}】]*(?:{_JUNK_WORDS})[^\)\]\}}】]*[\)\]\}}】]", re.I)
_FEAT = re.compile(r"\s*[\(\[]?\s*\b(?:ft|feat|featuring|prod)\b\.?\s+[^\)\]\-–—]*[\)\]]?", re.I)


def clean_channel(channel: str | None) -> str:
    c = channel or ""
    c = re.sub(r"\s*-\s*Topic$", "", c)
    c = re.sub(r"VEVO$", "", c)
    c = re.sub(r"\s*(Official|Music|Records|TV)\s*$", "", c, flags=re.I)
    return c.strip()


def clean_title(title: str, channel: str | None) -> tuple[str, str]:
    t = _JUNK_BRACKET.sub("", title or "")
    t = re.sub(r"\s*[|｜].*$", "", t)
    t = re.sub(r"\s*\b(official\s+)?(music\s+)?(lyric\s+)?video\b.*$", "", t, flags=re.I)
    artist, track = "", t
    for sep in (" - ", " – ", " — ", " -- ", " ~ ", " : "):
        if sep in t:
            artist, track = t.split(sep, 1)
            break
    if not artist:
        artist = clean_channel(channel)
    artist = _FEAT.sub("", artist).strip(" \"'“”")
    track = _FEAT.sub("", track).strip(" \"'“”")
    return artist, track


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower()).strip()


def _sim(a: str, b: str) -> float:
    a, b = _norm(a), _norm(b)
    if not a or not b:
        return 0.0
    if a in b or b in a:
        return 1.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def _score(c: dict[str, Any], artist: str, track: str, duration: float | None) -> float:
    s = 0.0
    if c.get("instrumental"):
        s -= 100
    if c.get("syncedLyrics"):
        s += 10
    elif c.get("plainLyrics"):
        s += 2
    else:
        s -= 50
    if duration and c.get("duration"):
        diff = abs(float(c["duration"]) - float(duration))
        s += 8 if diff <= 3 else 5 if diff <= 8 else 1 if diff <= 20 else -6
    s += 7 * _sim(c.get("trackName", ""), track) + 4 * _sim(c.get("artistName", ""), artist)
    return s


def _summary(c: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": c.get("id"),
        "trackName": c.get("trackName"),
        "artistName": c.get("artistName"),
        "albumName": c.get("albumName"),
        "duration": c.get("duration"),
        "synced": bool(c.get("syncedLyrics")),
        "hasLyrics": bool(c.get("syncedLyrics") or c.get("plainLyrics")),
    }


def _full(c: dict[str, Any], source: str = "lrclib") -> dict[str, Any]:
    return {
        **_summary(c),
        "source": source,
        "syncedLyrics": c.get("syncedLyrics"),
        "plainLyrics": c.get("plainLyrics"),
    }


async def _lrclib_get(client: httpx.AsyncClient, path: str, params: dict | None = None):
    try:
        r = await client.get(f"{LRCLIB}{path}", params=params)
        if r.status_code == 200:
            return r.json()
    except (httpx.HTTPError, ValueError):
        pass
    return None


@app.get("/api/lyrics")
async def lyrics(
    title: str = "",
    channel: str = "",
    artist: str = "",
    track: str = "",
    duration: float | None = None,
    q: str = "",
):
    """Find the best lyrics. `q` is a free-text manual search (used by the lyrics picker)."""
    if not (artist and track):
        a2, t2 = clean_title(title, channel)
        artist, track = artist or a2, track or t2
    artist, track = artist.strip(), track.strip()

    candidates: dict[Any, dict[str, Any]] = {}
    async with httpx.AsyncClient(headers={"User-Agent": UA}, timeout=12) as client:
        tasks = []
        if q:
            tasks.append(_lrclib_get(client, "/search", {"q": q}))
        else:
            if artist and track:
                params = {"artist_name": artist, "track_name": track}
                if duration:
                    params["duration"] = str(round(duration))
                tasks.append(_lrclib_get(client, "/get", params))
                tasks.append(
                    _lrclib_get(client, "/search", {"track_name": track, "artist_name": artist})
                )
                tasks.append(_lrclib_get(client, "/search", {"q": f"{artist} {track}"}))
            if track:
                tasks.append(_lrclib_get(client, "/search", {"track_name": track}))
            if title:
                tasks.append(_lrclib_get(client, "/search", {"q": " ".join(clean_title(title, "")).strip()}))
        for res in await asyncio.gather(*tasks):
            if isinstance(res, dict) and res.get("id"):
                res = [res]
            for c in res or []:
                if isinstance(c, dict) and c.get("id") is not None:
                    candidates.setdefault(c["id"], c)

        ranked = sorted(
            candidates.values(),
            key=lambda c: _score(c, artist or q, track or q, duration),
            reverse=True,
        )
        best = ranked[0] if ranked and _score(ranked[0], artist or q, track or q, duration) > 0 else None

        result: dict[str, Any] = {
            "query": {"artist": artist, "track": track, "duration": duration, "q": q},
            "best": _full(best) if best else None,
            "candidates": [_summary(c) for c in ranked[:20]],
        }

        # Fallback: lyrics.ovh (plain lyrics only)
        if not best and artist and track and not q:
            try:
                r = await client.get(f"{LYRICS_OVH}/{artist}/{track}")
                if r.status_code == 200 and r.json().get("lyrics"):
                    result["best"] = {
                        "id": None,
                        "trackName": track,
                        "artistName": artist,
                        "duration": duration,
                        "synced": False,
                        "hasLyrics": True,
                        "source": "lyrics.ovh",
                        "syncedLyrics": None,
                        "plainLyrics": r.json()["lyrics"],
                    }
            except (httpx.HTTPError, ValueError):
                pass
    return result


@app.get("/api/lyrics/id/{lid}")
async def lyrics_by_id(lid: int):
    async with httpx.AsyncClient(headers={"User-Agent": UA}, timeout=12) as client:
        c = await _lrclib_get(client, f"/get/{lid}")
    if not c:
        raise HTTPException(404, "Lyrics not found")
    return _full(c)


THUMB_DIR = CACHE / "thumbs"
THUMB_DIR.mkdir(parents=True, exist_ok=True)


@app.get("/api/thumb/{key}")
async def thumb(key: str):
    """Same-origin copy of a track's thumbnail (lets the listen page read its colours)."""
    if not re.fullmatch(r"[0-9a-f]{16}", key):
        raise HTTPException(400, "Bad key")
    path = THUMB_DIR / f"{key}.img"
    if not path.exists():
        url = (REGISTRY.get(key) or {}).get("thumb")
        if not url or not URL_RE.match(url):
            raise HTTPException(404, "No thumbnail")
        try:
            async with httpx.AsyncClient(headers={"User-Agent": UA}, timeout=10, follow_redirects=True) as c:
                r = await c.get(url)
            r.raise_for_status()
        except httpx.HTTPError as exc:
            raise HTTPException(502, f"Thumbnail fetch failed: {exc}") from exc
        path.write_bytes(r.content)
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "max-age=86400"})


@app.get("/api/health")
async def health():
    return {"ok": True, "yt_dlp": yt_dlp.version.__version__, "cached": len(REGISTRY)}


app.mount("/", StaticFiles(directory=STATIC, html=True), name="static")

if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
