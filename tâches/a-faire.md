# tâches/a-faire.md

> Source de vérité pour le travail en cours sur SUXAI.
> Mis à jour à chaque session : on planifie ICI avant de coder, on
> coche au fur et à mesure, on rédige une revue à la fin.
>
> Convention :
> - `[ ]` = à faire
> - `[~]` = en cours
> - `[x]` = terminé (et **vérifié**, voir CLAUDE.md §4)
> - `[-]` = abandonné / hors-scope (toujours expliquer pourquoi)

## En cours

_V2.2 livrée — voir Revue ci-dessous. Lot C (git avancé) + Output
panel + EOL/Encoding restent dans le backlog V2.3._

### V2.1 — parité VSCode (LIVRÉE — voir Revue 2026-04-28)

**Audit fait** par sous-agent : 5 working, 8 partial, 17 absent sur 30
features VSCode. Plan en 3 lots (Tier 1 d'abord = max impact, le reste
selon scope dispo).

**Plan**

- [ ] **Lot A — Tier 1 UX core (10 fixes)**
  - [ ] A1 — `Save All` (Cmd+K S) : ajouter `saveAllDirty()` dans
        WorkspaceContext + handler clavier window + entrée
        CommandPalette
  - [ ] A2 — `Auto-save` setting + impl (debounce 1s after edit)
  - [ ] A3 — `Format Document` (Shift+Alt+F) : Monaco
        `editor.action.formatDocument` exposé + handler
  - [ ] A4 — `Format on Save` setting + hook avant writeFile
  - [ ] A5 — `Trim trailing whitespace on save` setting + impl
  - [ ] A6 — `Problems panel` UI : nouveau composant ProblemsPanel
        consommant `editorContext.diagnostics`, toggle Cmd+Shift+M
  - [ ] A7 — `Output panel` UI : nouveau composant OutputPanel
        groupé par source (LSP, build, agent), toggle dans status bar
  - [ ] A8 — `EOL` indicator + `Encoding` indicator dans status bar
  - [ ] A9 — `Tab to spaces / spaces to tabs` commands dans
        CommandPalette + reformat actuel
  - [ ] A10 — Find/Replace : vérifier que Cmd+F (find) et Cmd+H
        (replace) fonctionnent vraiment, sinon ré-activer

- [ ] **Lot B — Tier 2 IDE navigation (6 fixes)**
  - [ ] B1 — `Go to Definition` (F12) — TS via Monaco gotoDefinition
  - [ ] B2 — `Peek Definition` (Alt+F12) — Monaco peekDefinition
  - [ ] B3 — `Find All References` (Shift+F12) — Monaco
        findReferences
  - [ ] B4 — `Rename Symbol` (F2) — Monaco rename action
  - [ ] B5 — `Symbol outline panel` (Cmd+Shift+O) — quick picker
        listant les symboles du fichier actif
  - [ ] B6 — `.vscode/settings.json` per-project : charger au workspace
        open, override le suxai.settings.v1 localStorage

- [ ] **Lot C — Tier 3 Git avancé (3 fixes prioritaires)**
  - [ ] C1 — Inline git blame : annotation par ligne sur cursor
        (Monaco contentWidget), data via `git blame -L N,N`
  - [ ] C2 — Git log viewer : modal listant les N derniers commits
        avec author/date/message
  - [ ] C3 — Stash list + apply/pop : add/list/apply/drop via
        SourceControlPanel

**Hors scope V2.1** (à voir après) :
- Multi-root workspaces (architectural, gros refactor WorkspaceContext)
- Workspace trust prompt (UX, pas critique)
- Continuous file watcher (le focus-reload couvre 95% des cas)
- Merge conflict UI (rare en flow agent-edit)
- Theme picker UI (data-theme switch via /command palette suffit)
- Zen mode, Walkthroughs (nice-to-have)

**Acceptance**
- `npm run typecheck` + `npm run build` OK
- Class names + JSX inchangés sauf nouveaux panels (Problems/Output)
- Bump à v2.1.0
- Pushé sur `claude/french-greeting-lGwbV`

## Backlog (priorisé)

Ces items sont identifiés mais pas encore planifiés. Quand on en
attaque un, le déplacer dans **En cours** avec un sous-plan détaillé
(éléments vérifiables, critères d'acceptation, fichiers touchés).

1. **Rotation de la clé Quatarly leaked.** Action utilisateur, pas
   code. Voir CLAUDE.md §"Security posture".
2. **Refresh-token côté client.** `authApi.refresh` existe mais
   n'est pas câblé sur les 401. Wire-it dans `src/api/client.ts`.
3. **Sauvegarde fichier (Cmd/Ctrl-S).** `updateActiveContent` marque
   dirty, pas de handler save. À brancher sur `window.suxai.fs.writeFile`.
4. **Build pipeline électron-builder** scripté → upload auto vers
   `/opt/suxai/releases/`.
5. **Persistance historique conversations AI** (localStorage ou IPC
   userData JSON).
6. **Tests serveur** (supertest) au minimum smoke pour `/auth/*` et
   `/ai/chat`.

## Revues — sessions terminées

Chaque entrée résume : ce qui a été fait, ce qui a été appris, et
les éventuels follow-ups identifiés en route.

### 2026-04-28 — V2.2.0 parité VSCode (Lot B navigation)
- **Fait** :
  - **B0 (déblocage majeur)** : workers Monaco vraiment activés.
    `src/main.tsx` importe les 5 workers via `?worker` suffix Vite
    (editor / ts / json / css / html) et les retourne dans
    `MonacoEnvironment.getWorker(_, label)`. Le worker stub (no-op)
    cassait silencieusement Go to Definition / Rename / Find Refs
    pour TS depuis V1. Build vérifié : 5 chunks `*.worker-*.js`
    générés dans `dist/assets/`.
  - **B1-B5 navigation** : 5 listeners ajoutés dans
    `EditorPanel.tsx` pour `suxai:reveal-definition`,
    `suxai:peek-definition`, `suxai:go-to-references`,
    `suxai:rename-symbol`, `suxai:quick-outline`. Chacun fait
    `editor.focus()` puis `getAction(...)?.run()` avec un toast info
    si l'action n'existe pas pour le langage. Monaco gère les
    raccourcis F12 / Alt+F12 / Shift+F12 / F2 / Cmd+Shift+O
    nativement quand l'éditeur a le focus — les listeners sont la
    voie palette/menu.
  - **CommandPalette** : 5 nouvelles entrées Editor (Go to Definition,
    Peek Definition, Find All References, Rename Symbol, Go to Symbol
    in File...) avec les hints clavier corrects.
  - **B6 `.vscode/settings.json`** : nouveau `lib/workspace-settings.ts`
    avec parser JSONC (strip line/block comments + trailing commas)
    et mapping VSCode → Settings SUXAI (fontSize, tabSize, wordWrap,
    minimap.enabled, formatOnSave, trimTrailingWhitespace, autoSave,
    autoSaveDelay). `lib/settings.ts` refactoré pour supporter une
    couche `workspaceOverrides` séparée — l'état effectif =
    user localStorage + overrides workspace, et le SettingsDialog
    écrit toujours seulement au niveau user (les prefs workspace ne
    fuient jamais en localStorage). `IDELayout` réapplique
    automatiquement à chaque changement de `workspaceRoot`.
- **Validation** : `npm run typecheck` + `npm run build` OK ;
  `dist/assets/{editor,ts,json,css,html}.worker-*.js` confirmés.
- **Hors scope V2.2 (déféré V2.3)** :
  - A7 Output panel (besoin infra IPC stdout streams)
  - A8 EOL/Encoding indicators (besoin extension IPC `fs:read-file`)
  - Lot C git avancé (blame/log/stash)
  - Multi-root workspaces (refactor architectural WorkspaceContext)
  - Workspace trust prompt
- **Suivi** : tester en runtime sur un vrai .ts du workspace (F12 sur
  un import doit naviguer ; F2 doit lancer le rename inline) — non
  vérifié dans cette session car build only.

### 2026-04-28 — V2.1.0 parité VSCode (Lot A)
- **Fait** :
  - **Settings** : 4 nouveaux paramètres (autosave, autosaveDelayMs,
    formatOnSave, trimTrailingWhitespaceOnSave) + UI dans
    SettingsDialog.
  - **Save pipeline** : refactor WorkspaceContext (helper persistOne),
    saveActiveFile accepte un transform, nouveau saveAllDirty.
  - **Shortcuts** : Cmd+S avec transform, Cmd+Alt+S Save All,
    Shift+Alt+F Format Document, Cmd+Shift+M Problems toggle.
  - **CommandPalette** : 5 nouvelles entrées (Save All, Format,
    Tabs↔Spaces, Problems toggle indirect via shortcut).
  - **Problems panel** : nouveau composant + lib/all-diagnostics.ts
    pour le stream global Monaco markers cross-file. StatusBar
    affiche les compteurs error/warning toujours.
  - **Auto-save** : useEffect debounced sur activeFile change,
    delay configurable, skip Format on Save (cursor jump risk).
- **Validation** : npm run typecheck + build OK.
- **Hors scope V2.1** :
  - Output panel (A7) — déféré V2.2, besoin infra IPC stdout streams.
  - EOL/Encoding indicators (A8) — déféré V2.2, requiert exposer
    eol/encoding depuis fs:read-file IPC.
  - Find/Replace (A10) — déjà natif Monaco, aucun bug observé.
- **Suivi** : Lot B (navigation : F12, Alt+F12, Shift+F12, F2,
  Cmd+Shift+O, .vscode/settings.json) et Lot C (git blame/log/stash)
  reportés en V2.2 (scope V2.1 déjà conséquent).

### 2026-04-27 — V2.0.1 fix bug « tourne en boucle » list_dir QUEUED
- **Fait** : root cause identifiée → quand `streamAi` rejette
  mid-stream (network) après `onToolUse`, les tool calls restent
  `pending` ad vitam. `chatToAgentMessages` les filtre (invariant
  Anthropic tool_use ↔ tool_result), Claude ne voit pas qu'il a
  tenté, re-émet le même `list_dir`, boucle infinie.
- **Fix** : try/catch autour du Promise streamAi dans `runAgentLoop`.
  Sur rejet, convertir tous les tool calls `pending` du current
  assistant message en `status: 'error'` avec un tool_result
  synthétique « Stream interrupted before tool ran… » avant de
  re-throw. Le modèle voit l'échec → adapte stratégie.
- **Validation** : typecheck + build OK. Leçon V2 ajoutée à
  `tâches/leçons.md`.

### 2026-04-27 — V2.0.0 refonte « Obsidian Warm »
- **Fait** : refonte visuelle totale en 18 lots (theme.css OKLCH +
  grain.css + monaco-suxai-theme.ts ; renderer entry fontsource +
  anti-FOUC ; Electron BrowserWindow vibrancy/mica ; toutes les
  surfaces composants repassées sur tokens). Inter Variable +
  Geist Mono. Light mode shippé via `[data-theme='light']`.
- **Validation** : typecheck + build OK ; audit grep brut → 0
  cubic-bezier hardcodé hors theme, 3 hex justifiés (SVG fallback +
  comment), 3 rgba justifiés (SuxaiLogo glint + xterm literal),
  21 inline style positioning légitime.
- **Leçons** : V3 ajoutée dans `tâches/leçons.md` (refactor-
  progress.md = méthode).

### 2026-04-27 — V1.0.0 refonte premium "digne du nom V1"
- **Fait** :
  - Phase A : type scale complet (--fs-2xs → --fs-3xl), poids
    (--fw-regular/medium/semibold/bold), line-heights, letter-
    spacing tokens. Système d'élévation explicite (--elevation-0 à
    -4 + -modal). Z-index ladder consolidé (--z-base/floor/tooltip/
    dropdown/overlay/modal/popover/toast). Tokens additionnels :
    --color-bg-overlay, --color-text-strong-2, --ease-snap.
  - Phase B : globals.css refait avec ambient 4-source + drift plus
    long (32 s) + vignette. Selection avec text-shadow halo accent.
    Scrollbar active state avec gradient indigo + glow. Animation
    suxai-breathe ajoutée (gentle pulse 3-4 s).
  - Phase B-Monaco : theme `suxai-dark` upgradé — palette indigo
    plus saturée (8b8efc keywords, b3b8fc operators), bracket
    highlight 6 niveaux, suggest/hover widgets stylés, gutter avec
    indicateurs add/modified/deleted, scrollbar slider en accent.
  - Phase C : Welcome cinematic — hero h2 26→34 px en font-display
    avec drop-shadow accent, brand pill avec dot animé (breathe) +
    halo, ambient parallax via animation drift, padding élargi.
  - Phase D : Button utilise font tokens (sans/medium/snug),
    transitions harmonisées sur dur-fast, hover ajoute lift 1 px
    partout. TitleBar brand mark avec halo + breathe. Sidebar label
    + StatusBar typo via tokens.
- **Validation** : `npm run typecheck` + `npm run build` OK.
- **Suivi** : la suite logique serait un onglet de réglages de
  thème (dark / dark+ / high-contrast) qui swap entre palettes.
  Hors-scope V1.

### 2026-04-27 — refonte visuelle v0.17.0 → v0.17.4
- **Fait** : refonte complète du système de tokens (theme.css 5-step
  ramp, glass utilities, motion spring), cascade sur toutes les
  surfaces visibles (TitleBar, ActivityBar, StatusBar, Sidebar,
  EditorPanel, AIPanel, modals). Extraction du système d'icônes
  fichiers vers `src/lib/file-icon.tsx`. Restructuration du AI
  panel header en 2 lignes propres. Ajout d'icônes colorées dans
  les onglets éditeur. Polish ciblé sur message head, composer
  chips, welcome cards, token bar, edited files, diff view, palette
  family.
- **Validation** : `npm run typecheck` + `npm run build` à chaque
  bump (v0.17.0, .1, .2, .3, .4) — tous OK.
- **Suivi** : la sidebar tree pourrait aussi recevoir un onglet
  refresh visuel mais c'est mineur. Aucun follow-up bloquant.
