import React from 'react';
import ReactDOM from 'react-dom/client';
import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';

// v2.0 — local font bundles. Inter Variable for UI, Geist Mono for
// code. Importing here lets Vite copy the woff2 to dist/ → no network
// fetch at runtime, Electron offline-first stays intact.
import '@fontsource-variable/inter';
import '@fontsource-variable/geist-mono';

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

// We don't ship Monaco's web workers in production (they require a
// special build step). Feed getWorker an inline empty worker so Monaco
// runs tokenization on the main thread — syntax highlighting still
// works for every registered language.
self.MonacoEnvironment = {
  getWorker() {
    const blob = new Blob(['self.onmessage=()=>{};'], {
      type: 'text/javascript',
    });
    return new Worker(URL.createObjectURL(blob));
  },
};

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
