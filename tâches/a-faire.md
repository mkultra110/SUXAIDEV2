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

_Aucun chantier actif. Démarrer par un plan ici avant la première édition de code._

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
