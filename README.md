# SUXAI — AI-powered desktop IDE

A premium Electron + React IDE with a built-in AI assistant (Quatarly-backed), secure login,
and a self-hosted auto-update system.

```
SUXAIDEV2/
├── electron/          # Electron main process + preload + updater
├── src/               # React renderer (UI)
├── server/            # VPS backend: auth, AI proxy, update manifest
├── package.json       # Client (Electron + React)
└── README.md
```

## Architecture

```
┌────────────────────┐   JWT     ┌─────────────────────────┐   apiKey   ┌──────────────────┐
│ Electron + React   │ ────────► │ VPS (Express)           │ ─────────► │ Quatarly API     │
│  - Monaco          │           │  /auth  /ai  /update    │            │ api.quatarly.cloud│
│  - safeStorage     │ ◄──────── │  bcrypt + JWT + helmet  │ ◄───────── │                  │
└────────────────────┘  tokens   └─────────────────────────┘  SSE       └──────────────────┘
```

**Security boundaries**

- The Quatarly API key lives **only** on the VPS. The client never sees it.
- Auth tokens are stored in Electron via `safeStorage` (OS-level encryption) — never in `localStorage`.
- The renderer runs with `contextIsolation: true`, `nodeIntegration: false`, and a strict CSP.
- The updater downloads over HTTPS, optionally verifies SHA-256, then hands off to the OS installer.

## Quickstart

### 1) Server (on your VPS — `209.99.186.238`)

```bash
cd server
cp .env.example .env
# Edit .env:
#   JWT_SECRET    = a 64-byte random hex string
#   QUATARLY_API_KEY = your Quatarly key
#   UPDATE_*      = pointing at your release binary

npm install
npm run build
npm start
```

Generate a strong `JWT_SECRET`:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

Default endpoints:

| Method | Path               | Auth     | Description                        |
| ------ | ------------------ | -------- | ---------------------------------- |
| GET    | `/health`          | public   | Liveness                           |
| POST   | `/auth/register`   | public   | `{email, password}` → tokens       |
| POST   | `/auth/login`      | public   | `{email, password}` → tokens       |
| POST   | `/auth/refresh`    | public   | `{refreshToken}` → new tokens      |
| GET    | `/auth/me`         | JWT      | Current user                       |
| GET    | `/ai/models`       | JWT      | Supported Quatarly model catalog   |
| POST   | `/ai/chat`         | JWT      | SSE stream — Quatarly proxy        |
| GET    | `/update/manifest` | public   | `{version, url, notes, sha256}`    |

### 2) Client

```bash
# at repo root
npm install
npm run dev
```

Environment (optional, `.env.local` at repo root):

```
VITE_API_BASE_URL=http://209.99.186.238:4000
VITE_UPDATE_MANIFEST_URL=http://209.99.186.238:4000/update/manifest
```

Defaults already point to your VPS IP when not set.

## AI models

All models are routed through the VPS `/ai/chat` endpoint. The client picks the model from
the dropdown in the AI panel. Supported model IDs (from the Quatarly docs):

- **Anthropic**: `claude-sonnet-4-6-thinking`, `claude-opus-4-6-thinking`, `claude-haiku-4-5-20251001`
- **OpenAI / Google (OpenAI-compatible)**: `gemini-3.1-pro`, `gemini-3-flash`, `gpt-5.4`,
  `gpt-5.2`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, `gpt-5.2-codex`, `gpt-5.3-codex`

## Context policy

The AI panel sends only what it needs — never the full project:

- active file path + language
- active file content (capped at 200 KB)
- current selection (capped at 50 KB)

## Deployment notes for the VPS

See `server/deploy/` for:

- `suxai-server.service` — systemd unit file
- `nginx.conf.example` — reverse proxy snippet with SSE-friendly settings

## Security caveat

The Quatarly API key `qua-17899503b9bf6973957a102d46c5a8dc` was disclosed in chat during
development. **Rotate it** before going to production and store the new key only in the
server's `.env` file (ignored by git).
