# tâches/leçons.md

> Mémoire long terme — chaque correction de l'utilisateur produit
> ici une règle qui empêche de refaire la même erreur. Relire ce
> fichier au début de chaque session avant de toucher au code.
>
> Convention par entrée :
> - **Symptôme** — ce qu'on a observé / ce que l'utilisateur a dit
> - **Cause** — pourquoi c'est arrivé
> - **Règle** — ce qu'on doit faire (ou ne pas faire) la prochaine fois

---

## Leçons antérieures (pré-2026-04)

### L1 — `vite-plugin-electron` import sans extension
- **Symptôme** : build cassé quand on écrit `import './updater.ts'`
  ou `'./updater.js'` dans `electron/main.ts`.
- **Cause** : `vite-plugin-electron` résout `./updater` sans
  extension explicite. L'ajouter casse le résolveur.
- **Règle** : pour les imports internes du process Electron main,
  ne JAMAIS écrire l'extension. Aussi noté dans CLAUDE.md
  §"Known sharp edges".

### L2 — `safeStorage` sur Linux headless
- **Symptôme** : tokens stockés en clair sur certaines machines Linux.
- **Cause** : `safeStorage.isEncryptionAvailable()` est `false`
  sans `gnome-keyring` / `kwallet`.
- **Règle** : pour tout target Linux serveur, flagger explicitement
  ce fallback. Considérer un toggle "stocker uniquement en mémoire"
  pour les déploiements headless.

### L3 — CORS_ORIGINS="*" rejeté par hardening
- **Symptôme** : service systemd `suxai-server` en crash-loop
  (1249 redémarrages, status 1).
- **Cause** : le hardening Express refuse `CORS_ORIGINS="*"` ;
  la config attend une liste explicite.
- **Règle** : pour `/opt/suxai/.env`, toujours fournir une liste
  d'origines explicites séparées par virgule, jamais `*`. Tester
  un `systemctl restart` + `journalctl -u suxai-server -n 50`
  après chaque édition `.env`.

### L4 — Agent edits invisibles si pas sur l'onglet actif
- **Symptôme** : "il fait que de lancer des reflexion + read file
  et modifie rien" — l'utilisateur ne voyait pas les diffs car le
  fichier édité n'était pas l'onglet actif.
- **Cause** : `openDiff` ne forçait pas l'ouverture du fichier dans
  les onglets ni le switch d'`activePath`. Le gate JSX
  `pendingDiff && activeFile?.path === pendingDiff.path` cachait
  l'`InlineDiff` sur un fichier non-actif.
- **Règle** : toute UI déclenchée par un événement doit s'assurer
  que les conditions de rendu (gate JSX) sont satisfaites. Quand
  on ajoute un gate `activeX?.path === pendingX.path`, vérifier
  que l'event ouvrant le pending fait aussi le set d'activeX.

### L5 — Capture-phase sur les listeners clavier
- **Symptôme** : raccourcis Cmd/Ctrl avalés par Monaco.
- **Cause** : Monaco enregistre ses propres listeners en bubble
  phase et `preventDefault()` ; les listeners app en bubble n'y
  arrivent pas.
- **Règle** : tous les listeners globaux clavier (CommandPalette,
  InlineEdit, SettingsDialog, etc.) doivent être en **capture
  phase** (`addEventListener(..., true)`). Sans ça → conflit
  systématique avec Monaco.

### L6 — Strict Mode + setState async
- **Symptôme** : `acceptDiff` accédait à `workspaceRoot` via une
  closure stale.
- **Cause** : React 18 Strict Mode + setState callback → la closure
  capture la valeur au render initial, pas au call time.
- **Règle** : pour toute valeur de contexte qui peut changer
  pendant un flow async, soit la lire via `stateRef.current`
  juste avant le call, soit la passer explicitement comme argument.
  Ne pas se reposer sur la closure du callback `setState`.

### L7 — Terminal auto-bracketing des URLs
- **Symptôme** : utilisateur avait `<URL>` collé en ligne shell
  bash, ce qui cassait la commande.
- **Cause** : son terminal (likely Windows Terminal en mode auto)
  bracketise les URLs collées.
- **Règle** : quand on donne une commande shell à coller, utiliser
  un HEREDOC bash avec variables (`S=http; H=...; curl "$S://$H..."`)
  pour éviter que le terminal ne touche aux URLs.

---

## Leçons par catégorie

### Architecture / patterns React

_(à remplir au fur et à mesure)_

### Sécurité / déploiement VPS

_(à remplir au fur et à mesure)_

### Visuel / CSS

### V1 — `mask-image` casse les `position: absolute` enfants
- **Symptôme** : envisagé un fade horizontal sur la tab strip via
  `mask-image` mais ça aurait coupé l'accent stripe `position:absolute`
  des onglets actifs.
- **Cause** : `mask-image` applique son alpha au compositing final,
  donc les pseudo-éléments absolus en dehors du gradient mask
  seraient eux-aussi affectés.
- **Règle** : pour des fade-edges sur un container scrollable,
  préférer un wrapper `position:relative` + `::after` `position:
  absolute` qu'on fade conditionnellement (avec une classe ajoutée
  par JS sur scroll). Le mask est trop blunt.

### V2 — Tool calls « QUEUED » à l'infini après une erreur réseau
- **Symptôme** : agent boucle sur `list_dir` (status QUEUED) sans
  jamais l'exécuter ; chaque turn empile un nouveau call list_dir
  identique. Visible : « Réflexion + list_dir QUEUED » répété.
- **Cause** : quand `streamAi` rejette mid-stream (network error,
  abort) APRÈS qu'`onToolUse` ait créé un tool call `status: 'pending'`
  mais AVANT que le code d'exécution post-stream ne tourne, le tool
  reste pending. `chatToAgentMessages` filtre les pending (ligne 127)
  → l'historique envoyé à Anthropic n'a aucun record du tool_use →
  Claude pense n'avoir jamais appelé le tool → re-émet le même
  tool_use. Si le réseau replante, on accumule des pending. Loop.
- **Règle** : sur rejet du Promise streamAi, AVANT de re-throw vers
  le `.catch` extérieur, convertir tous les tool calls `pending` du
  current assistant message en `status: 'error'` avec un tool_result
  synthétique. Ça maintient l'invariant tool_use ↔ tool_result requis
  par Anthropic ET permet au modèle de voir « j'ai tenté, ça a
  échoué » → adapter sa stratégie. Cf. AIPanel.tsx commit v2.0.1.

### V3 — Méga-prompt impose contexte management explicite
- **Symptôme** : refonte v2.0.0 demandait de toucher 60+ fichiers
  CSS. Sans persistance, un context reset au milieu = perte d'état
  (lots terminés vs restants, conventions choisies).
- **Règle** : dès qu'une refonte excède ~5 lots, créer
  `refactor-progress.md` à la racine avec : direction artistique
  figée, branche, lots terminés (avec commit hash), lots restants,
  notes critiques (bugs ouverts, adaptations chemins, audit cibles).
  Mettre à jour à chaque commit. Permet `cat refactor-progress.md
  → continue` après reset propre.
