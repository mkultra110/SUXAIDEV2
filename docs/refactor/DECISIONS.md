# Décisions architecturales — refonte v2

Chaque décision listée ici a un état : **OUVERT** (besoin de réponse user), **DÉCIDÉ** (fait), **REPORTÉ** (post-v2).

## D1 — Monorepo pnpm workspaces ?

- **État** : OUVERT
- **Question** : faut-il restructurer en `packages/{client,server,shared,electron}` avec pnpm workspaces ?
- **Pour** : type sharing client↔server, build cohérent, dx améliorée
- **Contre** : refactor massif, casse les scripts deploy actuels (`npm --prefix server run dev`), risque de régression sur le pipeline `.exe`
- **Recommandation** : reporter à la fin de la refonte (Phase 10), seulement après tests E2E verts. Sinon : garder `server/` séparé avec son propre `package.json` (état actuel).

## D2 — Layout : dockview-react vs maintien du split actuel ?

- **État** : OUVERT
- **Question** : remplacer `Layout` custom par `dockview-react` (panneaux dockables, drag-and-drop, sauvegarde layout) ?
- **Pour** : parité VSCode (panels redimensionnables, pinnable, multi-écran via popout)
- **Contre** : ajoute ~200KB, refait toute la couche layout
- **Recommandation** : oui, en Phase 3. Maintenir l'ancien Layout en backup pour rollback.

## D3 — IPC : MessageChannelMain vs ipcMain.handle actuel ?

- **État** : OUVERT
- **Question** : passer à MessageChannelMain pour ports typés / canaux dédiés ?
- **Pour** : meilleur isolement, multi-canaux parallèles (ex: terminal + LSP + DAP simultanés sans contention)
- **Contre** : refactor complet du preload/main bridge
- **Recommandation** : oui, Phase 2. Garde l'ancien `window.suxai.*` comme façade pour ne pas casser le code renderer existant.

## D4 — LSP : adaptateur vscode-languageserver-protocol direct vs monaco-languageclient ?

- **État** : OUVERT
- **Question** : `monaco-languageclient` (officiel TypeFox) ou intégration manuelle ?
- **Recommandation** : `monaco-languageclient` + `@codingame/monaco-vscode-api` pour parité VSCode max. Phase 4.

## D5 — Index sémantique : LanceDB embarqué vs serveur séparé ?

- **État** : OUVERT
- **Question** : LanceDB embarqué (process renderer ou utility) vs spawn d'un binary séparé ?
- **Recommandation** : utility process Electron + `lancedb` npm. Embeddings via Quatarly (modèle dédié) ou local (transformers.js). Phase 6.

## D6 — Modèles d'embeddings : remote (Quatarly) vs local (transformers.js + ONNX) ?

- **État** : OUVERT
- **Pour remote** : qualité, pas de RAM/CPU sur la machine user
- **Pour local** : offline, privacy, pas de coût
- **Recommandation** : option user dans settings. Default = local (BGE-small ou similaire) pour privacy. Phase 6.

## D7 — Signature releases : Ed25519 (libsodium) vs gpg ?

- **État** : OUVERT
- **Recommandation** : Ed25519 via `tweetnacl` ou `@noble/ed25519` — léger, pas de dépendance système. Clé privée sur le VPS, clé publique embarquée dans le client. Phase 8.

## D8 — Sandbox Electron : true en v2 ?

- **État** : REPORTÉ
- **Note** : passer sandbox:true casse le preload actuel qui utilise des modules Node. Nécessite refactor preload pour ne plus rien importer hors contextBridge purs. Faire en Phase 1 si fait, sinon Phase 11.

## D9 — Tests E2E : Playwright vs Spectron (déprécié) ?

- **État** : DÉCIDÉ
- **Choix** : Playwright (officiel pour Electron depuis 2022). Phase 9.

## D10 — Migration data store : SQLite (better-sqlite3) vs garder fichiers JSON ?

- **État** : OUVERT
- **Recommandation** : SQLite pour conversations/mémoires (volume), garder `users.json` (low-volume, atomicité simple). Phase 6 ou 7.

## D11 — Theming : tokens actuels vs adoption shiki + thèmes VSCode ?

- **État** : OUVERT
- **Recommandation** : garder les tokens CSS actuels pour l'UI ; ajouter `shiki` pour les blocs de code dans le chat AI (parité Cursor). Phase 3.

## D12 — Telemetry : opt-in ?

- **État** : OUVERT
- **Recommandation** : aucune télémétrie par défaut. Si ajoutée, opt-in explicite dans settings + endpoint VPS uniquement (jamais tiers).
