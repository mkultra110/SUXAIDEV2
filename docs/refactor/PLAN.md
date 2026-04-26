# SUXAI v2 — Plan de refonte VSCode/Cursor parity

**Branche** : `refactor/v2-vscode-cursor-parity` (isolée — ne touche PAS `claude/french-greeting-lGwbV` qui sert le VPS et le `.exe` en prod)

**Contrainte directrice** : « Le mieux sans tout casser ». Aucune restructuration destructive (monorepo pnpm, suppression de modules existants, rename massif) sans confirmation explicite par item.

## Objectif

Atteindre la parité fonctionnelle VSCode + Cursor pour SUXAI : éditeur Monaco multi-onglets robuste, panneau IDE complet (sidebar fichiers, search, source control, debug, extensions), AI agentique avec inline diffs / completions / chat, terminal intégré, LSP/DAP, recherche sémantique locale (LanceDB + tree-sitter), MCP servers, signature Ed25519 des releases, auto-update vérifié.

## Phases (10)

| # | Phase | État | Bloquant si destructif ? |
|---|---|---|---|
| 0 | Planning + tooling read-only (ce dossier) | en cours | non |
| 1 | Hardening Electron (sandbox:true, fuses, CSP stricte, IPC validé) | à faire | partiellement (sandbox peut casser preload existant) |
| 2 | IPC MessageChannelMain + handlers typés | à faire | non — peut cohabiter avec l'IPC actuel |
| 3 | Sidebar dockview-react (panels redimensionnables, pinnable) | à faire | non — feature additive |
| 4 | LSP client (typescript-language-server, pyright, gopls) | à faire | non — feature additive |
| 5 | DAP client (debug Node/Python) | à faire | non — feature additive |
| 6 | Index sémantique (tree-sitter + LanceDB embeddings locaux) | à faire | non — feature additive |
| 7 | Extensions/MCP (registry + sandbox utility process) | à faire | non — feature additive |
| 8 | Signature Ed25519 + verify avant install | à faire | non — additive sur updater existant |
| 9 | Tests E2E Playwright + CI matrix Win/Mac/Linux | à faire | non — additive |
| 10 | Migration monorepo pnpm | **À NE PAS FAIRE SANS CONFIRMATION** | OUI — destructif |

## Garde-fous

1. **Branche séparée** — toute la refonte vit dans `refactor/v2-vscode-cursor-parity`. Aucun cherry-pick vers `claude/french-greeting-lGwbV` sauf demande explicite.
2. **Pas de monorepo** sans confirmation explicite par phrase exacte type « oui passe en monorepo pnpm ».
3. **Pas de suppression** de fichiers existants (electron/, src/, server/) sans confirmation explicite.
4. **Toute phase** ajoute des fichiers/dossiers à côté ; refactor in-place uniquement après tests verts.
5. **Rollback plan** par phase : chaque phase finit par un commit atomique avec message `phase-N: <résumé>` pour revert facile.

## Critères de sortie Phase 0

- [x] Branche créée
- [x] Plan documenté (ce fichier)
- [ ] INVENTORY.md — état exact de v0.13.10
- [ ] DECISIONS.md — choix architecturaux ouverts
- [ ] PROGRESS.md — journal phase par phase
- [ ] Confirmation user pour Phase 1
