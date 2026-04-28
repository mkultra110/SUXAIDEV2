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

_V3.8.0 livrée (live-stream IPC + runTask streaming + agent
run_command streaming) — voir Revue ci-dessous. Restent : multi-root
workspaces + Departure Mono ghost text._

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

### 2026-04-28 — V3.8.0 live-stream IPC (chunks chemin OutputPanel)
- **Fait** :
  - **`terminal:run-stream`** (electron/main.ts) : nouveau IPC
    handler en parallèle de `run-once`, qui spawn la commande
    shell et **stream** chaque chunk stdout/stderr via
    `webContents.send('terminal:run-stream:chunk', { id, level, text })`.
    Émet `terminal:run-stream:end` à la complétion. Resolve
    après le close pour permettre `await`. Même hardening que
    run-once (timeout, kill SIGTERM puis SIGKILL après 2 s,
    sandbox cwd via resolvePath).
  - **Préload** : `terminal.runStream(input)` + listeners
    `onRunStreamChunk(cb)` / `onRunStreamEnd(cb)` qui retournent
    chacun une fonction de cleanup pour removeListener.
  - **`lib/run-stream.ts`** : helper `runStream({command, cwd,
    timeout_ms, source, banner?, id?})` qui :
    1) génère un `id` (multiplexing safe),
    2) écrit le banner `$ <command>` dans la source Output,
    3) abonne les chunks (chacun → `appendOutput(source, text, level)`),
    4) buffer en interne pour retourner `{ ok, stdout, exit_code,
       timed_out, error? }` à la fin (compat shape avec runOnce
       côté caller).
  - **`runTask` (lib/tasks.ts)** : remplacement de `runOnce` par
    `runStream` — les tasks workspace écrivent maintenant **chunk
    par chunk** dans le panneau Output au lieu d'un dump final.
    Shape de retour identique pour les appelants existants
    (CommandPalette, etc.).
  - **Agent `run_command`** (lib/agent.ts) : même bascule. Pendant
    qu'une commande shell tourne via le tool agent, l'utilisateur
    voit l'avancée en temps réel dans la source `Agent` du
    panneau Output. Le model récupère toujours le buffer complet.
- **Validation** : `npm run typecheck` + `npm run build` OK.
- **Hors scope** :
  - `runOnce` reste exposé : utilisé par d'autres call sites
    (server commit hooks, etc.) qui n'ont pas besoin de live —
    pas de raison d'imposer le coût d'IPC événementiel partout.
  - Output multi-conversation (une source `Agent` par conv id) —
    déféré.
  - Multi-root workspaces, Departure Mono ghost text.

### 2026-04-28 — V3.7.0 agent wiré sur Output panel
- **Fait** : `executeTool` (lib/agent.ts) wrappé pour émettre dans
  la source `Agent` du panneau Output.
  - Pré-call : `→ tool_name(brief input)` au level `info` (input
    JSON-stringifié + clip 120 chars).
  - Post success : résultat clip 800 chars au level `stdout` —
    full content reste dans la thread chat, le panneau Output garde
    une vue scannable.
  - Post error : `✗ tool_name: message` au level `error`.
- **Validation** : `npm run typecheck` + `npm run build` OK.
- **Effet visible** : pendant qu'un agent tourne, le panneau Output
  source `Agent` affiche en temps réel `→ read_file(...) → list_dir(...)`
  etc. avec le résultat synthétique. Un debug live des tool calls
  sans avoir à dérouler la thread.
- **Hors scope** : un seul source `Agent` partagé (pas une par
  conversation). À séparer plus tard si plusieurs threads tournent
  en parallèle.

### 2026-04-28 — V3.6.0 Output panel (A7, parité VSCode)
- **Fait** :
  - **`lib/output.ts`** : module event-emitter avec sources nommées,
    buffers en mémoire (cap 5000 lignes/source, 50 KB/ligne),
    notifications via `useSyncExternalStore` pour la liste des
    sources et `useState`+listeners pour le buffer d'une source.
    API : `appendOutput(source, text, level?)`, `clearOutput`,
    `dropOutputSource`, `useOutputSources`, `useOutput`.
  - **`<OutputPanel />`** : bottom panel parité VSCode avec source
    picker `<select>`, auto-scroll sticky-bottom (le user peut
    scroller up pour pinner), counts warn/error dans le head, bouton
    Clear + Close. Lignes timestamped + tinted par level (stdout
    neutre, warn miel, error/stderr terracotta, info honey-text).
  - **Wiring `runTask`** : la lib des tasks workspace écrit
    désormais ses lignes dans la source `Task: <label>` — banner
    `$ command`, stdout brut, footer `[exit N]` ou `[timed out]`.
    Le toast existant continue de fournir le feedback rapide.
  - **IDELayout** : state `outputOpen`, hotkey global `Cmd+Shift+U`
    (en plus du `Cmd+Shift+M` Problems existant), listener
    `suxai:open-output` event, render conditionnel
    `<OutputPanel height={240} />` avant la `<StatusBar />`.
  - **StatusBar** : nouveau bouton Output (icône `i-log`) entre
    Terminal et Problems quand le hôte passe `onToggleOutput`.
  - **CommandPalette** : entrée `View: Toggle Output Panel` (group
    Workspace, hint Ctrl+Shift+U).
- **Validation** : `npm run typecheck` + `npm run build` OK.
- **Hors scope (suite)** :
  - Stream IPC stdout/stderr en temps réel (live tail) : pour
    l'instant `runTask` capture l'output complet en fin de
    process. Une vraie spawn → stream → progressive append serait
    utile pour les builds longs ; nécessite un nouvel IPC
    `terminal:run-stream` qui pousse des chunks via `webContents`.
  - Wire de l'agent (lib/agent.ts) : tool calls `terminal:run-once`
    écrivent déjà via leur task path mais les autres outils
    (read_file, edit_file…) pourraient logger leur métadonnée dans
    une source `Agent`. Déféré.
  - Multi-root workspaces, Departure Mono ghost text.

### 2026-04-28 — V3.5.0 EOL + Encoding indicators (A8, parité VSCode)
- **Fait** :
  - **IPC** : `fs:read-file` exposait déjà la détection BOM + EOL via
    `detectQuirks` (les valeurs étaient stockées en `lastSeenQuirks`
    pour `applyQuirks` au write). Cette PR les expose au renderer
    dans le retour : `{ ..., eol: 'LF' | 'CRLF', encoding: 'UTF-8' |
    'UTF-8 with BOM' }`. Nouveau handler `fs:set-eol` qui patche
    `lastSeenQuirks[path].eol` — la prochaine writeFile sérialise
    avec le nouvel EOL.
  - **Preload** : extension du type retour `readFile()` + nouveau
    `setEol({path, eol})`.
  - **`OpenFile`** : ajout de `eol?: 'LF' | 'CRLF'` et
    `encoding?: 'UTF-8' | 'UTF-8 with BOM'`. 8 call sites
    `openFile({...})` dans le code propagent désormais
    `result.eol` / `result.encoding` (Sidebar tree, drop handler,
    Welcome recent, ProblemsPanel jump, SearchInFiles, QuickOpen,
    SourceControl, CommandPalette). Le path `fs.openFile()` (file
    picker dialog) ne propage pas — handler retourne `'utf8'` plain
    sans détection, encodage UTF-8 assumé.
  - **StatusBar** : 2 nouveaux items à droite, après "Ln/Col" :
    `UTF-8` (ou `UTF-8 BOM`) read-only + un bouton EOL `LF`/`CRLF`
    cliquable qui toggle via `fs:set-eol`, dispatch
    `suxai:eol-changed`, et marque le fichier dirty pour pousser le
    prochain Cmd+S à réécrire avec le nouvel EOL.
  - **WorkspaceContext** : listener `suxai:eol-changed` qui met à
    jour le `eol` de l'`OpenFile` correspondant pour que la
    StatusBar bascule visuellement immédiatement.
- **Validation** : `npm run typecheck` + `npm run build` OK.
- **Hors scope** : conversion d'encoding (UTF-8 ↔ UTF-16 ↔
  Windows-1252) — nécessiterait `iconv-lite` côté main process,
  pas une priorité immédiate. CommandPalette « Change End of Line »
  déféré (le click StatusBar suffit pour l'usage courant).
- **Suivi** : tester sur un repo Windows (CRLF natif) que les
  toggles persistent correctement après save+reload, et que les
  fichiers BOM-prefixed sont identifiés en `UTF-8 BOM`.

### 2026-04-28 — V3.4.0 sweep AtelierIcon round 2 (SourceControl + modals + TitleBar)
- **Fait** : second tour de sweep sur les composants de plus de
  surface remaining. ~25 inline SVGs supplémentaires remplacés.
  - **SourceControlPanel** : section chevrons (working tree +
    stashes) en `i-chevron-right` rotatif via inline style ;
    stash actions en `i-arrow-up-right` (pop) / `i-check` (apply) /
    `i-close` (drop) ; stage section + per-row plus en `i-plus`.
    Restent les 2 unstage minus glyphes inline (le sprite n'a pas
    de minus icon, tiny single-line glyphs OK à laisser).
  - **DiffView** : Accept/Reject buttons en `i-accept` / `i-reject`
    (icônes spécifiquement dessinées pour ça par le bundle).
  - **Message + ToolCall** : ToolCall dropdown chevron en
    `i-chevron-down`. Message avatar + diverted summary gardés en
    inline (gradient + green check overlay = identité visuelle).
  - **ModelSelector** : trigger chevron + check sur l'item actif
    (`i-chevron-down` + `i-check`).
  - **TitleBar** : logout button en `i-arrow-up-right`.
  - **UpdateDialog** : update header (`i-update`) + WhatsNew
    sparkle (`i-sparkle`).
  - **UpgradeDialog** : sparkle hero (`i-sparkle`).
  - **HistoryDialog** : title (`i-log`) + close (`i-close`).
  - **CompareDialog** : title (`i-diff`) + swap (`i-replace`) +
    close (`i-close`).
- **Validation** : `npm run typecheck` + `npm run build` OK. Bilan :
  passage de 16 fichiers avec SVG inline en V3.0 à 8 fichiers en
  V3.4 — les restants (AtelierIcon sprite host, EditorPanel md
  toggles, AIPanel hero sparkle, Message avatar, SuxaiLogo,
  MosaMascot, SourceControl unstage minus, Sidebar tab pin) sont
  tous **intentionnels** (gradient brand, mascotte, glyphe
  semantic-specific).
- **Hors scope (suite)** : Output panel (A7), EOL/Encoding (A8),
  multi-root workspaces, Departure Mono ghost text.

### 2026-04-28 — V3.3.0 sweep AtelierIcon sur 10 composants
- **Fait** : extension de `<AtelierIcon />` à toutes les surfaces UI
  visibles. Une vingtaine d'inline SVGs remplacés. Liste :
  - **ActivityBar** : i-file (explorer), i-git-branch (source
    control), i-search, i-gear (settings).
  - **Sidebar header** : i-git-branch / i-file (view toggle), i-file
    (open file btn), i-folder (open folder btn). Tree disclosure
    chevrons : `i-chevron-right` rotatif (90deg si expanded).
  - **EditorPanel** : tab close (i-close).
  - **Breadcrumbs** : separator (i-chevron-right).
  - **ProblemsPanel** : close button (i-close), group disclosure
    chevron (i-chevron-down avec class problems__chev rotatif).
  - **AIPanel** : Plan toggle (i-suggestion), New conversation
    button (i-plus), Jump-to-bottom (i-chevron-down), Plan-banner
    icon (i-suggestion), Plan-banner close (i-close).
  - **ConversationSwitcher** : trigger comment icon (i-comment),
    chevron drop (i-chevron-down rotatif), per-row delete
    (i-close), New conversation footer (i-plus).
  - **TerminalPanel** : title (i-terminal), search button (i-search).
  - **GitLogModal** : header icon (i-log).
  - **BranchPicker** : header icon (i-git-branch).
  - **SourceControlPanel + StatusBar** : déjà swappés en V3.2.0.
- **Validation** : `npm run typecheck` + `npm run build` OK. Le
  sprite est mounté UNE fois au root (App.tsx) et résolu via
  `<use href="#i-..." />` partout — coût zéro par instance.
- **Hors scope (suite)** : EditorPanel md/preview toggles, DiffView,
  HistoryDialog, UpdateDialog, UpgradeDialog, CompareDialog,
  TitleBar version dropdown — moins visibles, déférés. AIPanel
  empty-state sparkle hero gardé en custom (gradient bronze→honey
  signe l'identité).

### 2026-04-28 — V3.2.0 sprite Atelier 61 icônes
- **Fait** :
  - **Sprite import** : `icons.svg` du bundle Claude Design copié
    dans `src/assets/atelier-icons.svg` (61 symbols, viewBox 24×24,
    stroke `currentColor`, stroke-width 1.5).
  - **`<AtelierIcon />` composant** : `src/components/ui/AtelierIcon.tsx`
    avec un type `AtelierIconName` enum-string couvrant les 61 noms.
    Render `<svg width=size><use href="#i-name" /></svg>` qui résout
    contre le sprite mounté en App.
  - **`<AtelierIconSprite />`** : wrapper React qui inline le SVG du
    sprite via Vite `?raw` import + `dangerouslySetInnerHTML` dans
    un div hidden. Mounté une fois au root de App.tsx — toutes les
    `<AtelierIcon />` filles peuvent ensuite reférencer les
    `<symbol>` par ID.
  - **Proof-of-concept** : remplacement des inline SVGs dans
    `StatusBar` (terminal, git-branch, warning) et
    `SourceControlPanel` (branch, log/history, stash, sync, pull,
    push). Pull/push utilisent `i-arrow-right` avec rotation CSS
    pour garder une seule source d'icône.
- **Validation** : `npm run typecheck` + `npm run build` OK. Sprite
  shippé en bundle (16 KB), pas de fetch externe — offline-first
  Electron préservé.
- **Hors scope V3.2 (suite à faire)** :
  - Étendre le swap aux autres composants : TitleBar (window
    controls, brand), ActivityBar (sidebar nav icons), Sidebar
    (file tree expand/collapse, file kind icons), EditorPanel
    (tab close, breadcrumbs), AIPanel (sparkle/brain/suggestion),
    ProblemsPanel (severity dots → icons), GitLogModal (clock).
  - Pour `lib/file-icon.tsx` : décider si on remplace TOUS les
    icons par `i-file` / `i-file-code` / `i-file-md` génériques
    (cohérent Atelier mais perte d'identité par langue) ou on
    GARDE les chromatiques existants (le bundle ne livre pas de
    set par-langue, juste 3 icônes file génériques).
  - Departure Mono pour ghost text — pas dispo sur fontsource,
    fallback Monaspace Argon actif.
  - Output panel (A7), EOL/Encoding (A8), multi-root workspaces.

### 2026-04-28 — V3.1.0 polish visuel Atelier Dark
- **Fait** :
  - **L1 SuxaiLogo gradient** : la plate solide est devenue un vrai
    `<linearGradient>` SVG bronze-400 → bronze-500 → bronze-700
    (diagonal top-left → bottom-right), avec un glint top-edge en
    second `<linearGradient>` ivoire transparent → 0. IDs suffixés
    via `useId()` pour cohabitation multi-instance. Tokens CSS
    overridables : `--suxai-logo-grad-{top,mid,bot}` +
    `--suxai-logo-glint-{top,bot}`. Variant light qui inverse
    discrètement les stops.
  - **L2 Welcome hero** : ajout de `<MosaMascot size={92} />`
    au-dessus du brand block avec drop-shadow honey + animation
    `suxai-mascot-float` (translateY -4px, 6 s, ease-in-out-circ).
    Le brand pill text-only est devenu une row `<SuxaiLogo /> + SUXAI`
    avec drop-shadow accent sur le logo. Le `::before` dot animé
    a été retiré (le logo plate joue désormais ce rôle).
  - **L3 TitleBar wordmark** : gradient text-mask sur
    `.titlebar__brand-name` qui glisse de `--color-text-primary`
    (ivoire warm) vers `color-mix(--color-text-primary 75%,
    --color-accent-text)` (vers le miel). Donne au mot « SUXAI »
    le sentiment d'une seule pièce monochrome avec le logo plate
    cuivre. Fallback `@supports not (background-clip: text)` pour
    les vieux moteurs.
- **Validation** : `npm run typecheck` + `npm run build` OK.
- **Hors scope V3.1 (déféré V3.2)** :
  - Set ~90 icônes custom du bundle (`icons.svg`) — swap de
    `lib/file-icon.tsx`, mérite son propre lot
  - Departure Mono pour le ghost text IA — pas dispo sur fontsource
  - LoginScreen Mosa decoration (déjà bien chargé visuellement)
  - AIPanel header brand cue (risque d'encombrer)
  - Output panel (A7), EOL/Encoding (A8), multi-root workspaces
- **Suivi** : tester en runtime que (1) le gradient logo rend bien
  sur les écrans HiDPI, (2) Mosa flotte sans scintillement sur les
  GPUs modestes, (3) le gradient text-mask wordmark reste lisible
  même quand l'éditeur est focused.

### 2026-04-28 — V3.0.0 refonte visuelle « Atelier Dark »
- **Fait** :
  - **Source** : bundle `suxaia/` reçu de `claude.ai/design` (URL
    Anthropic Design hostée). README direct : « recreate them
    pixel-perfectly in whatever technology fits the codebase » +
    consigne explicite de NE PAS render dans le browser (lire le
    code directement). Architecture 3 couches OKLCH.
  - **Fonts** (L1) : swap `@fontsource-variable/inter` +
    `@fontsource-variable/geist-mono` → `@fontsource-variable/geist`
    + `@fontsource/monaspace-argon`. Tokens `--font-sans` /
    `--font-mono` / `--font-display` / nouveau `--font-ghost`
    (Departure Mono attendu, fallback Monaspace Radon → Argon).
  - **theme.css** (L2) : réécriture complète. Nouvelles primitives
    bronze / honey / sage / terra / slate / parch (12 stops OKLCH
    chacune), tier 2 sémantiques `--color-bg-*` / `--color-text-*` /
    `--color-accent` (bronze-500) / `--color-accent-text` (honey-500)
    / success/warning/danger/focus-ring mappés sur les nouvelles
    primitives. **Legacy aliases conservés** : `--amber-1..12`,
    `--neutral-1..12`, `--green-9`, `--coral-9`, `--terra-9`,
    `--teal-9`, `--rose-9`, `--red-9` pointent désormais sur la
    palette Atelier Dark — la cascade CSS applique automatiquement
    la nouvelle direction sans toucher un seul composant. Variante
    light parchment + fallback hex `@supports not (color: oklch(0 0 0))`.
  - **Monaco theme** (L3) : `lib/monaco-suxai-theme.ts` réécrit
    avec la palette Atelier Dark (bg `#26201a`, fg `#d9cfb9`,
    cursor honey `#d4a247`, brackets cuivre/miel/sauge/lavande/
    ciel/orange en 6 niveaux distincts, gutter add/modified/deleted
    sage/honey/terra). Variant light parchemin avec primary
    `#94532c`.
  - **Mosa mascot** (L4) : `components/ui/MosaMascot.tsx` —
    composant React qui inline le SVG `mosa-base.svg` (champignon
    cuivre + ventre miel + luciole compagnon en glow filter). IDs
    suffixés via `useId()` pour éviter les collisions defs entre
    instances. Exposé pour Welcome / splash / About — non placé
    automatiquement dans cette PR (à brancher quand utile).
  - **globals.css** (L5) : aucun changement nécessaire — `::selection`
    et `::-webkit-scrollbar-thumb` consomment déjà
    `var(--color-accent)` via `color-mix`, donc la cascade applique
    bronze automatiquement. Idem pour `.gradient-border` qui utilise
    `var(--amber-9)` (alias → bronze-500).
- **Validation** : `npm run typecheck` + `npm run build` OK.
- **Hors scope V3.0.0 (déféré V3.1)** :
  - Repaint per-composant (TitleBar brand-mark gradient, hero
    typography Welcome, AIPanel polishing) — la cascade suffit
    pour un premier pass mais finition ciblée à faire
  - Set ~90 icônes custom du bundle (`icons.svg`) — swap de
    `lib/file-icon.tsx` mérite son propre lot
  - Departure Mono pour ghost text IA — pas dispo sur fontsource,
    fallback actuel Monaspace Argon
  - Output panel (A7), EOL/Encoding (A8), multi-root workspaces
- **Suivi** : tester en runtime sur la prochaine build (`.exe` via
  GitHub Actions) — vérifier que la palette bronze/miel rend bien,
  que Monaco ouvre dans le nouveau thème, que les fontes Geist +
  Monaspace Argon s'affichent. Si le rendu manque de cohésion
  visuelle, planifier un V3.1 polishing ciblé.

### 2026-04-28 — V2.3.0 parité VSCode (Lot C git avancé)
- **Fait** :
  - **IPC** : 7 nouveaux handlers dans `electron/main.ts` (blame,
    log, stash-list/push/pop/apply/drop). Réutilise `runGitNoTimeout`,
    `resolveRepoRoot`, et un nouveau helper `toRepoRelative`. Les
    indices de stash sont validés (`Number.isInteger`, 0–1000) et
    passés sous forme `stash@{N}` directement à git (spawn ne passe
    pas par le shell, donc les `{}` sont preservés).
  - **Préload** : 7 nouvelles entrées dans `git.*` avec types stricts
    pour le payload + retour.
  - **lib/git.ts** : interfaces `BlameLine`/`GitCommit`/`GitStash`,
    helpers `getFileBlame` (avec cache invalidé sur `git-refresh`),
    `getGitLog` (one-shot, refetch à chaque ouverture du modal),
    `listStashes`/`stashPush`/`stashPop`/`stashApply`/`stashDrop`,
    `useGitStashes` hook réactif, et utilitaire `relativeTime`.
  - **C1 inline blame** (`EditorPanel.tsx`) : useEffect qui s'attache
    à `editor.onDidChangeCursorPosition` (debounce 200 ms),
    fetch blame de la ligne courante, et insère un Monaco injected-
    text decoration `after` avec `Author · 3d ago · summary` en
    italique muted. Skip silencieux pour le sha all-zeros (« Not
    Committed Yet »). Setting `gitBlame` (default true) avec toggle
    SettingsDialog ; mapping `git.blame.enabled` ajouté dans
    `workspace-settings.ts`. CSS `.suxai-blame-annotation` dans
    EditorPanel.css.
  - **C2 git log viewer** : nouveau `components/Sidebar/GitLogModal.tsx`
    + `.css`. Portal pattern identique à BranchPicker, fuzzy filter
    sur subject+author+sha, click sur un commit pour développer le
    body. `GitLogHost` monté dans App.tsx. Trigger via
    `openGitLog()` (CommandPalette « Git: Show History… » + bouton
    horloge dans le SourceControlPanel sync row).
  - **C3 stashes** : section « Stashes » dans `SourceControlPanel`
    (cachée si vide) avec 3 actions par stash (Pop / Apply / Drop) +
    bouton « Stash All » dans le sync row (icône archive). Entrées
    CommandPalette « Git: Stash All Changes » et « Git: Pop Latest
    Stash ». Tous les stash actions invalident `git-refresh` →
    propagation automatique aux badges sidebar + Source Control.
- **Validation** : `npm run typecheck` + `npm run build` OK.
- **Hors scope V2.3 (déféré V2.4)** :
  - A7 Output panel (besoin infra IPC stdout streams)
  - A8 EOL/Encoding indicators (besoin extension IPC `fs:read-file`)
  - Multi-root workspaces (refactor architectural WorkspaceContext)
  - Blame gutter side-bar (juste contentWidget pour l'instant)
  - Diff entre 2 commits depuis le log viewer (read-only seulement)
- **Suivi** : tester en runtime sur un vrai repo (ouvrir un .ts
  versionné, vérifier que l'annotation blame s'affiche ; ouvrir
  Git: Show History ; faire stash all + pop) — non vérifié dans
  cette session car build only.

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
