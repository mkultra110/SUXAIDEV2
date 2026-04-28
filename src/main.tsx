import React from 'react';
import ReactDOM from 'react-dom/client';
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';

// v3.0 — local font bundles for « Atelier Dark » design system.
// Geist Variable for UI (replacing Inter), Monaspace Argon for code
// (replacing Geist Mono). Importing here lets Vite copy the woff2
// to dist/ → no network fetch at runtime, Electron offline-first
// stays intact.
import '@fontsource-variable/geist';
import '@fontsource/monaspace-argon';

// v2.2 — real Monaco language workers. Vite's `?worker` suffix bundles
// each worker as a separate chunk and gives us a constructor we can
// instantiate. Without these, Go to Definition / Rename / Find
// References cannot return TS results (the actions exist but the
// language service runs on the main thread with no resolver).
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

import { App } from './App';
import { startAllDiagnosticsStream } from './lib/all-diagnostics';
import './styles/theme.css';
import './styles/globals.css';
import './styles/grain.css';

// v2.1 — boot the cross-file Monaco markers stream once. The Problems
// panel + status-bar counters subscribe via `useAllDiagnostics()`. Idempotent.
startAllDiagnosticsStream();

// Bundle Monaco locally instead of loading from jsDelivr CDN — Electron
// packaged apps load index.html via file:// and CDN requests were hanging,
// which is why less-common languages (Lua, Kotlin, Dart…) showed
// "Loading…" forever.
loader.config({ monaco });

self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    if (label === 'json') return new jsonWorker();
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker();
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker();
    if (label === 'typescript' || label === 'javascript') return new tsWorker();
    return new editorWorker();
  },
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
