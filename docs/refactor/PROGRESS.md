# Journal de progression — refonte v2

Format : `[YYYY-MM-DD] phase-N : action — résultat`

## 2026-04-26

- `[2026-04-26] phase-0 : branche refactor/v2-vscode-cursor-parity créée depuis eab8aa3 (v0.13.10)`
- `[2026-04-26] phase-0 : PLAN.md / INVENTORY.md / DECISIONS.md / PROGRESS.md ajoutés sous docs/refactor/`
- `[2026-04-26] phase-0 : STOP — attente confirmation user pour Phase 1 (hardening Electron)`

## Prochaines actions (en attente confirmation)

1. Phase 1 — Hardening Electron
   - Configurer Electron Fuses (RunAsNode off, NodeOptions off, etc.)
   - CSP renforcée (déjà override en packaged, à étendre en dev)
   - Audit IPC : tous les `ipcMain.handle` doivent valider leurs args via zod
   - Decision OUVERTE : sandbox:true (cf D8)

2. Phase 2 — IPC MessageChannelMain (cf D3)

3. Phase 3 — dockview-react (cf D2)

## Règles de log

- Une ligne par action significative
- Toujours préfixer par phase
- Si destructif : ajouter `[DESTRUCTIVE]` avant la description
- Si revert : ligne séparée `[YYYY-MM-DD] phase-N : REVERT <commit> — raison`
