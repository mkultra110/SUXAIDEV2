# Refonte « Obsidian Warm » — état d'avancement

Source de vérité de la refonte v2.0. Permet de reprendre proprement
après un context reset (cf. méga-prompt §13). Lire ce fichier au début
de toute nouvelle session avant de toucher au code.

## Direction artistique confirmée

**Obsidian Warm** : warm espresso bg (#0F0E0D base, #13110F sidebar),
amber accent **#F5C97A** signature, 6 teintes syntaxiques max (sage,
terra, teal, coral, rose, amber). Inter Variable + Geist Mono. Shadows
en couches dark + inset highlight. Animations 100–300ms ease-out-expo.
Tokens en OKLCH avec hex fallback en commentaire.

## Branche & convention

- Branche : `claude/french-greeting-lGwbV`
- Commits : `refactor(visual): batch N — <description>`
- Bump cible final : **v2.0.0**
- Class names + JSX 100% inchangés (sauf cas Monaco theme + Login logo)

## Lots terminés

- [x] **Lot 1** — `theme.css` Obsidian Warm + `grain.css` + `monaco-suxai-theme.ts`. Commit `4ba74a6`.
- [x] **Lot 2** — `main.tsx` (fontsource imports) + `index.html` (anti-FOUC inline script + meta theme-color) + `globals.css` (réécrit). Commit `3af5e07`.
- [x] **Lot 3** — `electron/main.ts` BrowserWindow (vibrancy/mica/trafficLights) + nativeTheme IPC handlers. Commit `b0ac169`.
- [x] **Lot 4** — `TitleBar.css` réécrit + `SuxaiLogo.tsx/.css` token-driven. Commit `6d9a708`.

## Lots restants

- [ ] **Lot 5** — `Sidebar.tsx/.css` (header overline, row 24 px, active stripe slide).
- [ ] **Lot 6** — `SourceControlPanel.css` + `BranchPicker.css`.
- [ ] **Lot 7** — `EditorPanel.css` tab bar (strip 34 px, top accent stripe).
- [ ] **Lot 8** — `EditorPanel.css` body + `Breadcrumbs.css` + Monaco settings (Geist Mono, line height 1.65).
- [ ] **Lot 9** — `StatusBar.css` (24 px) + `ActivityBar.css`.
- [ ] **Lot 10** — `CommandPalette.css` (glass-panel + 18% top + stagger).
- [ ] **Lot 11** — `AIPanel.css` header + composer.
- [ ] **Lot 12** — `Message.css` + `CodeBlock.css` + `ToolCall.css` + `EditedFilesPanel.css`.
- [ ] **Lot 13** — `ModelSelector.css` + `ConversationSwitcher.css` + `TokenUsageBar.css` + `ApprovalDialog.css`.
- [ ] **Lot 14** — `LoginScreen.tsx/.css` (grain overlay, card 400 px, stagger 60 ms).
- [ ] **Lot 15** — `UpdateDialog.css` + `UpgradeDialog.css` + `CompareDialog.css` + `HistoryDialog.css` + `SettingsDialog.css`.
- [ ] **Lot 16** — `InlineDiff.css` + `InlineEdit.css` + `DiffView.css` + `MarkdownPreview.css` + `TerminalPanel.css`.
- [ ] **Lot 17** — `Button.css` + `Input.css` + `ContextMenu.css` + `Toast.css` + `QuickOpen.css` + `SearchInFiles.css`.
- [ ] **Lot 18** — Audit grep + checklist 27 items + typecheck/build/push v2.0.0.

## Notes critiques

1. **Bug `tourne en boucle` (list_dir QUEUED)** — séparé de la refonte
   visuelle, à traiter post-Lot 18. Hypothèse : le tool executor ne
   transitionne jamais le status `pending → running`. Voir `AIPanel.tsx:
   504+` pour le check `tc.status === 'pending'` et le filtrage du turn
   suivant.

2. **Monaco custom theme** — déjà extrait vers
   `src/lib/monaco-suxai-theme.ts`. EditorPanel.tsx:373+ appelle
   `defineSuxaiThemes(monaco)` puis `setTheme(suxaiThemeForMode(mode))`.
   Mode lu depuis `document.documentElement.dataset.theme`.

3. **Adaptations chemins méga-prompt** — le doc référence
   `src/renderer/...`, notre arbo réelle est `src/...` (pas de
   sous-dossier renderer). Tous les chemins corrigés au fil de l'eau.

4. **Light mode** — sémantiques overridées dans `[data-theme='light']`
   block au sein de `theme.css`. Encore non testé visuellement, audit
   des composants nécessaire en Lot 18.

5. **Audit grep cibles** :
   ```
   grep -rEn '#[0-9a-fA-F]{3,8}\b' src --include='*.tsx' --include='*.ts' \
     | grep -v 'theme.css' | grep -v 'monaco-suxai-theme'
   # → 0 lignes
   grep -rEn 'rgba?\(|hsla?\(' src --include='*.tsx' --include='*.css' \
     | grep -v 'theme.css'
   # → 0 lignes (sauf borders alpha dans theme.css)
   grep -rEn 'cubic-bezier|[0-9]+ms\b' src --include='*.tsx' --include='*.css' \
     | grep -v 'theme.css'
   # → 0 lignes
   grep -rEn 'style=\{\{' src --include='*.tsx'
   # → 0 lignes (ou avec REFACTOR-NOTE)
   ```

## Reprise après reset

```bash
git fetch origin claude/french-greeting-lGwbV
git pull
cat refactor-progress.md
# Reprendre au lot suivant non coché.
```
