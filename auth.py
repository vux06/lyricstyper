"""Google sign-in, sessions and per-user data, stored in SQLite.

Set GOOGLE_CLIENT_ID to turn sign-in on. Without it the app runs open (local use)
and the browser keeps everything in localStorage as before.
"""

from __future__ import annotations

import json
import os
import secrets
import sqlite3
import threading
import time
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse

CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
ENABLED = bool(CLIENT_ID)
DB_PATH = Path(os.environ.get("DB_PATH", Path(__file__).resolve().parent / "data" / "lyricstyper.db"))
COOKIE = "lt_session"
SESSION_DAYS = 30
# browser storage keys that follow the user across devices
SYNC_KEYS = {"lt_settings", "lt_listen", "lt_history", "lt_tracks"}
MAX_VALUE = 2_000_000

_lock = threading.Lock()
_db: sqlite3.Connection | None = None


def db() -> sqlite3.Connection:
    global _db
    if _db is None:
        DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        _db = sqlite3.connect(DB_PATH, check_same_thread=False, isolation_level=None)
        _db.row_factory = sqlite3.Row
        _db.executescript(
            """
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS users (
              id INTEGER PRIMARY KEY, sub TEXT UNIQUE NOT NULL, email TEXT, name TEXT,
              picture TEXT, created INTEGER, last_login INTEGER);
            CREATE TABLE IF NOT EXISTS sessions (
              token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
              created INTEGER, expires INTEGER);
            CREATE TABLE IF NOT EXISTS user_data (
              user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL,
              value TEXT NOT NULL, updated INTEGER, PRIMARY KEY (user_id, key));
            """
        )
    return _db


def q(sql: str, args: tuple = ()) -> list[sqlite3.Row]:
    with _lock:
        return db().execute(sql, args).fetchall()


def user_for(request: Request) -> dict | None:
    tok = request.cookies.get(COOKIE)
    if not tok:
        return None
    rows = q(
        "SELECT u.id, u.email, u.name, u.picture FROM sessions s JOIN users u ON u.id = s.user_id "
        "WHERE s.token = ? AND s.expires > ?",
        (tok, int(time.time())),
    )
    return dict(rows[0]) if rows else None


def user_data(uid: int) -> dict:
    return {r["key"]: json.loads(r["value"]) for r in q("SELECT key, value FROM user_data WHERE user_id = ?", (uid,))}


def _is_https(request: Request) -> bool:
    return request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"


PUBLIC_PREFIXES = ("/api/auth/", "/api/health")
PAGES = {"/": "index.html", "/index.html": "index.html", "/listen.html": "listen.html"}


def install(app: FastAPI, static: Path) -> None:
    db()

    @app.middleware("http")
    async def guard(request: Request, call_next):
        path = request.url.path
        if ENABLED and path.startswith("/api/") and not path.startswith(PUBLIC_PREFIXES):
            user = user_for(request)
            if not user:
                return JSONResponse({"detail": "sign in required"}, status_code=401)
            request.state.user = user
        return await call_next(request)

    def page(name: str, request: Request):
        # pages are public (so search engines and visitors can read them); the API needs sign-in
        user = user_for(request) if ENABLED else None
        boot = {"auth": ENABLED, "user": user, "data": user_data(user["id"]) if user else None}
        js = json.dumps(boot).replace("</", "<\\/")
        html = (static / name).read_text().replace("</head>", f"<script>window.LT_BOOT={js};</script>\n</head>", 1)
        return HTMLResponse(html, headers={"Cache-Control": "no-store"})

    def page_route(name: str):
        async def handler(request: Request):
            return page(name, request)
        return handler

    for route, name in PAGES.items():
        app.add_api_route(route, page_route(name), methods=["GET"], include_in_schema=False)

    @app.get("/login.html", include_in_schema=False)
    async def login_page(request: Request):
        if not ENABLED or user_for(request):
            return RedirectResponse("/", 302)
        return HTMLResponse((static / "login.html").read_text(), headers={"Cache-Control": "no-store"})

    @app.get("/api/auth/config")
    async def config():
        return {"enabled": ENABLED, "client_id": CLIENT_ID}

    @app.post("/api/auth/google")
    async def google_login(request: Request):
        if not ENABLED:
            raise HTTPException(400, "sign-in is not configured")
        body = await request.json()
        cred = str(body.get("credential") or "")
        if not cred:
            raise HTTPException(400, "missing credential")
        # Google checks the signature and expiry; we check it was issued for this app
        async with httpx.AsyncClient(timeout=10) as c:
            r = await c.get("https://oauth2.googleapis.com/tokeninfo", params={"id_token": cred})
        if r.status_code != 200:
            raise HTTPException(401, "invalid google token")
        info = r.json()
        if info.get("aud") != CLIENT_ID or info.get("iss") not in ("accounts.google.com", "https://accounts.google.com"):
            raise HTTPException(401, "token was not issued for this app")
        if int(info.get("exp", 0)) < time.time():
            raise HTTPException(401, "token expired")
        t = int(time.time())
        q(
            "INSERT INTO users (sub, email, name, picture, created, last_login) VALUES (?,?,?,?,?,?) "
            "ON CONFLICT(sub) DO UPDATE SET email=excluded.email, name=excluded.name, "
            "picture=excluded.picture, last_login=excluded.last_login",
            (info["sub"], info.get("email"), info.get("name") or info.get("email"), info.get("picture"), t, t),
        )
        uid = q("SELECT id FROM users WHERE sub = ?", (info["sub"],))[0]["id"]
        tok = secrets.token_urlsafe(32)
        q("DELETE FROM sessions WHERE expires < ?", (t,))
        q("INSERT INTO sessions (token, user_id, created, expires) VALUES (?,?,?,?)", (tok, uid, t, t + SESSION_DAYS * 86400))
        resp = JSONResponse({"ok": True})
        resp.set_cookie(COOKIE, tok, max_age=SESSION_DAYS * 86400, httponly=True, samesite="lax", secure=_is_https(request))
        return resp

    @app.post("/api/auth/logout")
    async def logout(request: Request):
        tok = request.cookies.get(COOKIE)
        if tok:
            q("DELETE FROM sessions WHERE token = ?", (tok,))
        resp = JSONResponse({"ok": True})
        resp.delete_cookie(COOKIE)
        return resp

    @app.get("/api/me")
    async def me(request: Request):
        return {"auth": ENABLED, "user": getattr(request.state, "user", None)}

    @app.put("/api/data/{key}")
    async def put_data(key: str, request: Request):
        if key not in SYNC_KEYS:
            raise HTTPException(404, "unknown key")
        user = getattr(request.state, "user", None)
        if not user:
            return {"ok": True, "stored": False}
        raw = await request.body()
        if len(raw) > MAX_VALUE:
            raise HTTPException(413, "too large")
        json.loads(raw)  # must be valid JSON
        q(
            "INSERT INTO user_data (user_id, key, value, updated) VALUES (?,?,?,?) "
            "ON CONFLICT(user_id, key) DO UPDATE SET value=excluded.value, updated=excluded.updated",
            (user["id"], key, raw.decode(), int(time.time())),
        )
        return {"ok": True, "stored": True}
