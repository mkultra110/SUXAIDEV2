/// <reference types="vite/client" />

import type { SuxaiApi } from '../electron/preload';

declare global {
  interface Window {
    suxai: SuxaiApi;
  }
}

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  readonly VITE_UPDATE_MANIFEST_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

export {};
