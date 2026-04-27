"""
hermes-bridge: a thin HTTP service that:
  1. Implements a Telegram-driven device-pairing flow for new clients (VSCode)
  2. Issues per-client bearer tokens
  3. Proxies OpenAI-compatible requests to hermes' built-in api_server,
     authenticating with the master API_SERVER_KEY on the client's behalf

Layout:

    VSCode ext  ──HTTP/SSE──►  hermes-bridge :8643  ──HTTP/SSE──►  hermes api_server :8642
                                       │
                                       └── Telegram Bot API (sendMessage with approval link)

Run with the hermes venv so aiohttp is available:

    /home/dev/.hermes/hermes-agent/venv/bin/python /home/dev/hermes-bridge/bridge.py
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import secrets
import sqlite3
import time
from html import escape
from pathlib import Path
from typing import Optional

import aiohttp
from aiohttp import web

# ─── Config ─────────────────────────────────────────────────────────────────

HERMES_HOME = Path(os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes"))
BRIDGE_DIR = Path(os.environ.get("HERMES_BRIDGE_DIR") or "/home/dev/hermes-bridge")
DB_PATH = BRIDGE_DIR / "bridge.db"


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k = k.strip()
        v = v.strip().strip('"').strip("'")
        os.environ.setdefault(k, v)


_load_dotenv(HERMES_HOME / ".env")

UPSTREAM_URL = os.environ.get("BRIDGE_UPSTREAM", "http://127.0.0.1:8642")
UPSTREAM_KEY = os.environ.get("API_SERVER_KEY", "")
TG_BOT_TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "")
TG_HOME_CHAT = os.environ.get("TELEGRAM_HOME_CHANNEL", "")
PUBLIC_URL = os.environ.get("BRIDGE_PUBLIC_URL", "http://127.0.0.1:8643").rstrip("/")
BIND_HOST = os.environ.get("BRIDGE_HOST", "0.0.0.0")
BIND_PORT = int(os.environ.get("BRIDGE_PORT", "8643"))

CODE_TTL_SECONDS = 600           # 10 min — short enough that abandoned codes don't pile up
TOKEN_TTL_SECONDS = 90 * 86400   # 90 d — re-pair after that
PAIR_INIT_LIMIT = 5              # max pair_init bursts per IP per window
PAIR_INIT_WINDOW = 600           # 10 min sliding window
ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"  # no 0/O/1/I

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s"
)
log = logging.getLogger("hermes-bridge")


# ─── Storage ────────────────────────────────────────────────────────────────

def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    BRIDGE_DIR.mkdir(parents=True, exist_ok=True)
    with db() as c:
        c.executescript("""
            CREATE TABLE IF NOT EXISTS pair_codes (
                code        TEXT PRIMARY KEY,
                csrf        TEXT NOT NULL,
                client_name TEXT,
                status      TEXT NOT NULL,
                token       TEXT,
                created_at  REAL NOT NULL,
                expires_at  REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS tokens (
                token       TEXT PRIMARY KEY,
                client_name TEXT,
                created_at  REAL NOT NULL,
                last_used_at REAL,
                expires_at  REAL,
                revoked_at  REAL
            );
            CREATE TABLE IF NOT EXISTS rate_limit (
                bucket      TEXT NOT NULL,
                ts          REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_rate_limit_bucket_ts ON rate_limit(bucket, ts);
            CREATE TABLE IF NOT EXISTS audit_log (
                ts          REAL NOT NULL,
                token_pfx   TEXT,
                client_name TEXT,
                method      TEXT,
                path        TEXT,
                status      INTEGER,
                ip          TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
        """)
        # Best-effort schema migration for existing dbs
        try: c.execute("ALTER TABLE tokens ADD COLUMN expires_at REAL")
        except sqlite3.OperationalError: pass
        try: c.execute("ALTER TABLE tokens ADD COLUMN revoked_at REAL")
        except sqlite3.OperationalError: pass


def make_code() -> str:
    return "".join(secrets.choice(ALPHABET) for _ in range(8))


def make_csrf() -> str:
    return secrets.token_hex(16)


def make_token() -> str:
    return "hbk_" + secrets.token_hex(24)


# ─── Telegram helper ────────────────────────────────────────────────────────

async def tg_send_pairing_message(
    session: aiohttp.ClientSession, code: str, csrf: str, client_name: str
) -> None:
    if not TG_BOT_TOKEN or not TG_HOME_CHAT:
        log.warning("Telegram not configured; pairing code %s must be approved manually", code)
        return
    approve_url = f"{PUBLIC_URL}/pair/approve?code={code}&csrf={csrf}"
    text = (
        f"\U0001F510 *VSCode pairing request*\n\n"
        f"Client: `{client_name}`\n"
        f"Code:   `{code}`\n\n"
        f"[✅ Approve]({approve_url})\n\n"
        f"_Code expires in {CODE_TTL_SECONDS // 60} minutes._"
    )
    api = f"https://api.telegram.org/bot{TG_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": TG_HOME_CHAT,
        "text": text,
        "parse_mode": "Markdown",
        "disable_web_page_preview": True,
    }
    try:
        async with session.post(api, json=payload, timeout=aiohttp.ClientTimeout(total=8)) as r:
            if r.status != 200:
                log.warning("Telegram sendMessage failed: %s %s", r.status, await r.text())
    except Exception as e:
        log.warning("Telegram sendMessage error: %s", e)


# ─── Pairing endpoints ──────────────────────────────────────────────────────

def _purge_expired() -> None:
    now = time.time()
    with db() as c:
        c.execute("DELETE FROM pair_codes WHERE expires_at < ?", (now,))
        c.execute("DELETE FROM rate_limit WHERE ts < ?", (now - PAIR_INIT_WINDOW,))
        # tokens: drop hard-revoked or long-expired; keep audit trail intact
        c.execute(
            "DELETE FROM tokens WHERE (expires_at IS NOT NULL AND expires_at < ?)"
            " OR (revoked_at IS NOT NULL AND revoked_at < ?)",
            (now, now - 86400)
        )


def _client_ip(req: web.Request) -> str:
    # Trust X-Forwarded-For from the local Cloudflare/cloudflared loopback only.
    fwd = req.headers.get("X-Forwarded-For", "")
    if fwd and req.remote in ("127.0.0.1", "::1"):
        return fwd.split(",")[0].strip()
    return req.remote or "?"


def _rate_limit_check(bucket: str) -> bool:
    """Return True if request is within limit; False if it should be 429'd."""
    now = time.time()
    with db() as c:
        c.execute("DELETE FROM rate_limit WHERE bucket=? AND ts < ?",
                  (bucket, now - PAIR_INIT_WINDOW))
        n = c.execute(
            "SELECT COUNT(*) FROM rate_limit WHERE bucket=?", (bucket,)
        ).fetchone()[0]
        if n >= PAIR_INIT_LIMIT:
            return False
        c.execute("INSERT INTO rate_limit (bucket, ts) VALUES (?, ?)", (bucket, now))
    return True


def _audit(req: web.Request, status: int, token: Optional[str] = None,
           client_name: Optional[str] = None) -> None:
    try:
        with db() as c:
            c.execute(
                "INSERT INTO audit_log (ts, token_pfx, client_name, method, path, status, ip) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (time.time(),
                 (token[:12] + "…") if token else None,
                 client_name,
                 req.method, req.path, status,
                 _client_ip(req))
            )
    except Exception as e:
        log.warning("audit insert failed: %s", e)


async def pair_init(req: web.Request) -> web.Response:
    _purge_expired()
    ip = _client_ip(req)
    if not _rate_limit_check(f"pair_init:{ip}"):
        log.warning("pair_init rate-limited: %s", ip)
        _audit(req, 429)
        return web.json_response(
            {"error": "rate_limited", "retry_after": PAIR_INIT_WINDOW},
            status=429
        )
    body = await req.json() if req.can_read_body else {}
    client_name = (body or {}).get("client_name") or "Unknown client"
    client_name = str(client_name)[:80]

    code = make_code()
    csrf = make_csrf()
    now = time.time()
    with db() as c:
        c.execute(
            "INSERT INTO pair_codes (code, csrf, client_name, status, created_at, expires_at) "
            "VALUES (?, ?, ?, 'pending', ?, ?)",
            (code, csrf, client_name, now, now + CODE_TTL_SECONDS),
        )

    await tg_send_pairing_message(req.app["http"], code, csrf, client_name)

    log.info("pair_init: code=%s client=%s ip=%s", code, client_name, ip)
    _audit(req, 200, client_name=client_name)
    return web.json_response({
        "code": code,
        "expires_in": CODE_TTL_SECONDS,
        "instructions": "Open Telegram and tap the Approve button on the new message.",
    })


async def pair_poll(req: web.Request) -> web.Response:
    body = await req.json() if req.can_read_body else {}
    code = (body or {}).get("code", "").upper().strip()
    if not code:
        return web.json_response({"error": "missing code"}, status=400)
    _purge_expired()
    with db() as c:
        row = c.execute(
            "SELECT status, token FROM pair_codes WHERE code = ?", (code,)
        ).fetchone()
    if not row:
        return web.json_response({"error": "invalid_or_expired"}, status=410)
    if row["status"] != "approved":
        return web.json_response({"status": "pending"}, status=202)
    return web.json_response({"status": "approved", "token": row["token"]})


_APPROVED_HTML = """\
<!doctype html><html><head><meta charset="utf-8">
<title>Approved</title>
<style>
body{{font-family:system-ui;background:#0d1117;color:#c9d1d9;
  display:grid;place-items:center;height:100vh;margin:0}}
.card{{background:#161b22;padding:24px 32px;border-radius:8px;
  border:1px solid #30363d;text-align:center;max-width:420px}}
.ok{{color:#3fb950;font-size:48px;margin:0}}
small{{color:#8b949e}}
</style></head><body><div class="card">
<p class="ok">✅</p><h2>{title}</h2>
<p>Client <code>{client}</code> can now use Hermes via this bridge.</p>
<small>You can close this tab.</small>
</div></body></html>
"""


async def pair_approve(req: web.Request) -> web.Response:
    code = req.query.get("code", "").upper().strip()
    csrf = req.query.get("csrf", "").strip()
    if not code or not csrf:
        return web.Response(status=400, text="missing code or csrf")
    _purge_expired()
    with db() as c:
        row = c.execute(
            "SELECT csrf, client_name, status, token FROM pair_codes WHERE code = ?",
            (code,),
        ).fetchone()
        if not row:
            return web.Response(status=410, text="code expired or invalid")
        if not secrets.compare_digest(row["csrf"], csrf):
            return web.Response(status=403, text="csrf mismatch")
        if row["status"] == "approved":
            html = _APPROVED_HTML.format(
                title="Already approved", client=escape(row["client_name"] or "")
            )
            return web.Response(text=html, content_type="text/html")
        token = make_token()
        now = time.time()
        c.execute(
            "UPDATE pair_codes SET status='approved', token=? WHERE code=?",
            (token, code),
        )
        c.execute(
            "INSERT INTO tokens (token, client_name, created_at, expires_at) "
            "VALUES (?, ?, ?, ?)",
            (token, row["client_name"], now, now + TOKEN_TTL_SECONDS),
        )
    log.info("pair_approve: code=%s client=%s", code, row["client_name"])
    html = _APPROVED_HTML.format(title="Approved", client=escape(row["client_name"] or ""))
    return web.Response(text=html, content_type="text/html")


# ─── Token-authenticated proxy to api_server ────────────────────────────────

def _client_token(req: web.Request) -> Optional[str]:
    auth = req.headers.get("Authorization", "")
    if not auth.lower().startswith("bearer "):
        return None
    parts = auth.split(None, 1)
    if len(parts) < 2:
        return None
    return parts[1].strip() or None


def _validate_token(token: str) -> bool:
    if not token:
        return False
    now = time.time()
    with db() as c:
        row = c.execute(
            "SELECT expires_at, revoked_at FROM tokens WHERE token = ?", (token,)
        ).fetchone()
        if not row:
            return False
        if row["revoked_at"] is not None:
            return False
        if row["expires_at"] is not None and row["expires_at"] < now:
            return False
        c.execute("UPDATE tokens SET last_used_at = ? WHERE token = ?", (now, token))
        return True


def _token_client_name(token: str) -> Optional[str]:
    with db() as c:
        row = c.execute("SELECT client_name FROM tokens WHERE token = ?", (token,)).fetchone()
        return row["client_name"] if row else None


async def pair_revoke(req: web.Request) -> web.Response:
    """Revoke the calling client's own bearer token. No body needed —
    the token to revoke comes from Authorization. Idempotent: 200 even
    if already revoked or unknown."""
    token = _client_token(req)
    if not token:
        return web.json_response({"error": "missing bearer"}, status=401)
    name = _token_client_name(token)
    with db() as c:
        c.execute(
            "UPDATE tokens SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL",
            (time.time(), token),
        )
    log.info("pair_revoke: client=%s token=%s…", name, token[:12])
    _audit(req, 200, token=token, client_name=name)
    return web.json_response({"status": "revoked", "client_name": name})


async def pair_audit(req: web.Request) -> web.Response:
    """Return last 50 audit entries for the calling token."""
    token = _client_token(req)
    if not token or not _validate_token(token):
        return web.json_response({"error": "unauthorized"}, status=401)
    pfx = (token[:12] + "…")
    with db() as c:
        rows = c.execute(
            "SELECT ts, method, path, status, ip FROM audit_log "
            "WHERE token_pfx = ? ORDER BY ts DESC LIMIT 50",
            (pfx,)
        ).fetchall()
    return web.json_response({
        "count": len(rows),
        "entries": [
            {"ts": r["ts"], "method": r["method"], "path": r["path"],
             "status": r["status"], "ip": r["ip"]}
            for r in rows
        ]
    })


async def proxy(req: web.Request) -> web.StreamResponse:
    token = _client_token(req)
    if not token or not _validate_token(token):
        _audit(req, 401, token=token)
        return web.json_response({"error": "unauthorized"}, status=401)

    upstream_path = req.match_info.get("path", "")
    target = f"{UPSTREAM_URL}/v1/{upstream_path}"
    if req.query_string:
        target += "?" + req.query_string

    # Forward body as-is. For SSE we must stream both directions without
    # buffering, so we use an iter_chunked → write loop.
    body = await req.read() if req.method in ("POST", "PUT", "PATCH") else None
    headers = {
        "Authorization": f"Bearer {UPSTREAM_KEY}",
        "Content-Type": req.headers.get("Content-Type", "application/json"),
    }
    # Pass through hermes-specific session headers if the client sent them.
    for h in ("X-Hermes-Session-Id", "Idempotency-Key", "Accept"):
        if h in req.headers:
            headers[h] = req.headers[h]

    session: aiohttp.ClientSession = req.app["http"]
    try:
        upstream = await session.request(
            req.method, target, data=body, headers=headers,
            timeout=aiohttp.ClientTimeout(total=None, sock_read=600),
        )
    except aiohttp.ClientError as e:
        return web.json_response({"error": f"upstream unreachable: {e}"}, status=502)

    # Stream the response back. Preserve Content-Type so SSE works.
    resp = web.StreamResponse(
        status=upstream.status,
        headers={
            k: v for k, v in upstream.headers.items()
            if k.lower() in ("content-type", "cache-control", "x-hermes-session-id")
        },
    )
    await resp.prepare(req)
    try:
        async for chunk in upstream.content.iter_any():
            if not chunk:
                continue
            await resp.write(chunk)
    finally:
        upstream.release()
    await resp.write_eof()
    _audit(req, upstream.status, token=token, client_name=_token_client_name(token))
    return resp


# ─── App wiring ─────────────────────────────────────────────────────────────

async def on_startup(app: web.Application) -> None:
    app["http"] = aiohttp.ClientSession()
    init_db()
    log.info(
        "hermes-bridge: bind=%s:%s upstream=%s public=%s tg_configured=%s",
        BIND_HOST, BIND_PORT, UPSTREAM_URL, PUBLIC_URL, bool(TG_BOT_TOKEN and TG_HOME_CHAT),
    )


async def on_cleanup(app: web.Application) -> None:
    s: aiohttp.ClientSession = app["http"]
    await s.close()


async def health(_: web.Request) -> web.Response:
    return web.json_response({"status": "ok", "service": "hermes-bridge"})


def make_app() -> web.Application:
    app = web.Application(client_max_size=10 * 1024 * 1024)
    app.on_startup.append(on_startup)
    app.on_cleanup.append(on_cleanup)
    app.router.add_get("/health", health)
    app.router.add_post("/pair/init", pair_init)
    app.router.add_post("/pair/poll", pair_poll)
    app.router.add_get("/pair/approve", pair_approve)
    app.router.add_post("/pair/revoke", pair_revoke)
    app.router.add_get("/pair/audit", pair_audit)
    # OpenAI-compat proxy — anything under /v1/* requires a paired token
    app.router.add_route("*", "/v1/{path:.*}", proxy)
    return app


if __name__ == "__main__":
    web.run_app(make_app(), host=BIND_HOST, port=BIND_PORT, access_log=None)
