/**
 * Shared file-icon system — used by Sidebar tree AND Editor tabs (v0.17.2).
 * Extracted from Sidebar.tsx so the editor tabs can render identical
 * coloured icons for the user's file extension. Keeping a single source of
 * truth means a future kind addition propagates everywhere.
 */
import type { JSX } from 'react';

export type FileIconKind =
  | 'ts' | 'js' | 'json' | 'md' | 'css' | 'html' | 'image'
  | 'shell' | 'lock' | 'config' | 'lua' | 'cpp' | 'python'
  | 'rust' | 'go' | 'java' | 'csharp' | 'php' | 'ruby' | 'sql'
  | 'yaml' | 'xml' | 'pdf' | 'archive' | 'binary' | 'plain';

export function iconKindForFile(name: string): FileIconKind {
  const lower = name.toLowerCase();
  if (/^(\.gitignore|\.gitattributes|\.gitmodules)$/.test(lower)) return 'config';
  if (/^(dockerfile|docker-compose\.ya?ml)$/.test(lower)) return 'config';
  if (/^(readme|license|changelog|notice)$/i.test(lower.replace(/\..*$/, ''))) return 'md';
  if (/^(makefile|cmakelists\.txt|justfile|taskfile\.ya?ml)$/.test(lower)) return 'config';
  if (/^package(-lock)?\.json$/.test(lower)) return 'json';
  if (/^pnpm-lock\.ya?ml$|^yarn\.lock$|^cargo\.lock$|^poetry\.lock$/.test(lower)) return 'lock';
  const ext = lower.split('.').pop() ?? '';
  switch (ext) {
    case 'ts': case 'tsx': case 'mts': case 'cts': return 'ts';
    case 'js': case 'jsx': case 'mjs': case 'cjs': return 'js';
    case 'json': case 'jsonc': return 'json';
    case 'md': case 'mdx': case 'markdown': case 'rst': return 'md';
    case 'css': case 'scss': case 'sass': case 'less': case 'styl': return 'css';
    case 'html': case 'htm': case 'svg': case 'xhtml': return 'html';
    case 'png': case 'jpg': case 'jpeg': case 'gif': case 'webp': case 'ico': case 'bmp': return 'image';
    case 'sh': case 'bash': case 'zsh': case 'fish': case 'ps1': case 'bat': case 'cmd': return 'shell';
    case 'lua': return 'lua';
    case 'cpp': case 'cc': case 'cxx': case 'c': case 'h': case 'hpp': case 'hxx': return 'cpp';
    case 'py': case 'pyi': case 'pyx': return 'python';
    case 'rs': return 'rust';
    case 'go': return 'go';
    case 'java': case 'kt': case 'kts': case 'scala': return 'java';
    case 'cs': case 'fs': case 'vb': return 'csharp';
    case 'php': case 'phtml': return 'php';
    case 'rb': case 'erb': return 'ruby';
    case 'sql': case 'psql': return 'sql';
    case 'yml': case 'yaml': case 'toml': return 'yaml';
    case 'xml': case 'plist': return 'xml';
    case 'pdf': return 'pdf';
    case 'zip': case 'tar': case 'gz': case 'bz2': case 'xz': case '7z': case 'rar': return 'archive';
    case 'exe': case 'dll': case 'so': case 'dylib': case 'wasm': return 'binary';
    case 'env': case 'editorconfig': case 'prettierrc': case 'eslintrc': case 'ini': case 'conf': return 'config';
    default: return 'plain';
  }
}

export function FileIcon({ kind, size = 14 }: { kind: FileIconKind; size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6z"
        fill="currentColor"
        fillOpacity="0.14"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
      />
      <path
        d="M14 3v6h6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinejoin="round"
        fill="none"
      />
      {kind === 'ts' && <text x="6.5" y="17.5" fontSize="6.5" fontWeight="700" fill="currentColor">TS</text>}
      {kind === 'js' && <text x="6.5" y="17.5" fontSize="6.5" fontWeight="700" fill="currentColor">JS</text>}
      {kind === 'json' && <text x="5.5" y="17.5" fontSize="5.5" fontWeight="700" fill="currentColor">JSON</text>}
      {kind === 'css' && <text x="5.5" y="17.5" fontSize="6" fontWeight="700" fill="currentColor">CSS</text>}
      {kind === 'md' && <text x="5.5" y="17.5" fontSize="6.5" fontWeight="700" fill="currentColor">MD</text>}
      {kind === 'lua' && <text x="5.5" y="17.5" fontSize="6.5" fontWeight="700" fill="currentColor">LUA</text>}
      {kind === 'cpp' && <text x="5.5" y="17.5" fontSize="6" fontWeight="700" fill="currentColor">C++</text>}
      {kind === 'python' && <text x="5.5" y="17.5" fontSize="6" fontWeight="700" fill="currentColor">PY</text>}
      {kind === 'rust' && <text x="5.5" y="17.5" fontSize="5.5" fontWeight="700" fill="currentColor">RS</text>}
      {kind === 'go' && <text x="6" y="17.5" fontSize="6.5" fontWeight="700" fill="currentColor">GO</text>}
    </svg>
  );
}
