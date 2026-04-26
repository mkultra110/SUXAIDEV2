# Inventaire v0.13.10 — état avant refonte

Référence : commit `eab8aa3` sur `claude/french-greeting-lGwbV`.

## Stack actuelle

| Couche | Tech | Version |
|---|---|---|
| Runtime desktop | Electron | 30.0.9 |
| UI | React + Vite | 18.3.1 + 5.2.11 |
| Editor | Monaco standalone | 0.50.0 (via `@monaco-editor/react` 4.6.0) |
| Terminal | xterm.js | 5.5.0 |
| Build | electron-builder | 24.13.3 |
| Bundler client | vite-plugin-electron | 0.28.7 |
| Backend | Express + TS | (server/ — non versionné dans package.json racine) |
| LLM proxy | Quatarly (Anthropic-compat) | endpoint VPS |

## Surfaces existantes (NE PAS CASSER)

### Client (`src/`)
- `App.tsx` — routing Login ↔ IDE
- `contexts/AuthContext.tsx` — JWT + safeStorage
- `contexts/WorkspaceContext.tsx` — fichiers ouverts, onglets, pendingDiff + pendingDiffQueue
- `components/Layout/` — split panes
- `components/Sidebar/` — arbre fichiers VSCode-like (v0.13.10 redesign)
- `components/Editor/EditorPanel.tsx` — Monaco + InlineDiff par hunk (Alt+↵, Alt+J/K)
- `components/Editor/InlineDiff.tsx` — décorations + view zones (PAS DiffEditor split)
- `components/AI/AIPanel.tsx` — chat agentique, runAgentLoop, 21 slash commands, mémoire auto
- `components/AI/ConversationSwitcher.tsx` — switch conversations
- `components/AI/ModelSelector.tsx` — choix modèle
- `components/Settings/SettingsDialog.tsx` — approval mode + memory manager
- `components/UpdateDialog/` — auto-update UI
- `lib/agent.ts` — runUnderPathLock + locateSearch + buildSearchNotFoundError
- `lib/memories.ts` — Haiku-extracted facts
- `lib/settings.ts` — approvalMode (auto/step/yolo)
- `api/quatarly.ts` — SSE streaming Anthropic Messages format
- `api/client.ts` — fetch + JWT refresh
- `config.ts` — AI_MODELS catalog, API_BASE_URL

### Electron (`electron/`)
- `main.ts` — sanitizeFsPath realpath, atomicWrite, CSP override packaged, will-navigate allowlist
- `preload.ts` — deepFreeze + contextBridge api
- `updater.ts` — electron-updater + SHA-256 verify

### Server (`server/`)
- `routes/auth.ts` — register/login/refresh/me + loginUserLimiter (v0.13.8 fix username)
- `routes/ai.ts` — chat SSE + /apply (Haiku) + /count-tokens
- `routes/update.ts` — manifest
- `services/quatarly.service.ts` — proxy SSE Anthropic native + thinking blocks + cache_control
- `services/auth.service.ts` — bcrypt 12
- `store/users.ts` — file-backed atomic writes
- `middleware/auth.ts` — JWT vérif
- `schemas/ai.ts` — SUPPORTED_MODELS

### VPS (`/opt/suxai/`)
- `app/` — code serveur (rsync depuis `server/`)
- `data/users.json` — 0700, owned suxai
- `logs/server.log`
- `releases/` — installeurs servis par nginx
- `.env` — JWT_SECRET + QUATARLY_API_KEY (0600)

## Bugs critiques fixés (à NE PAS régresser)

| Version | Bug | Fix |
|---|---|---|
| v0.12.10 | Loop infini pause_turn | fall-through tool execution |
| v0.12.10 | pendingDiff stuck "1 pending" | pendingDiffQueue FIFO |
| v0.12.12 | Data-loss parallel edit_file | runUnderPathLock per-path |
| v0.12.13 | Tabs same file (InlineDiff overlay) | gate path === pendingDiff.path |
| v0.13.8 | run_command approval bypass | normalizeApprove(await opts.approve) |
| v0.13.8 | loginUserLimiter dead | keyGenerator req.body.username |
| v0.13.8 | @-mentions accents broken | regex unicode `[\p{L}_]` |
| v0.13.8 | mention cleanup duplicate | split.join + Set dedup |
| v0.13.10 | Apply button data-loss | route via /ai/apply (Haiku merge) |

## Manques connus (cibles du v2)

- ❌ Sidebar : pas de Search global / Source Control / Debug / Extensions panels
- ❌ Pas de LSP (autocomplete intelligent dépendant uniquement de Monaco builtins)
- ❌ Pas de DAP (pas de debug step-through)
- ❌ Pas d'index sémantique local (RAG limité au contexte fichier ouvert + @mentions)
- ❌ Pas de MCP servers
- ❌ Pas de signature Ed25519 sur les releases
- ❌ Pas de tests E2E
- ❌ Pas de matrix CI Win/Mac/Linux (seulement Windows via GitHub Actions)
- ❌ sandbox:false (deferred — casserait preload existant sans refonte IPC)
- ❌ Electron Fuses non configurés
- ❌ Refresh token rotation non câblé côté client

## Métriques

- LOC client : ~ TBD (à mesurer)
- LOC server : ~ TBD
- Bundle client : ~ TBD (vite build)
- Démarrage à froid Windows : ~ TBD
