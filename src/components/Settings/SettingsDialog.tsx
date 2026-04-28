import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../ui/Button';
import { useSettings } from '../../lib/settings';
import { AI_MODELS } from '../../config';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { useMemories, deleteMemory } from '../../lib/memories';
import { useMcpServers, readMcpConfig } from '../../lib/mcp';
import { useSnippets } from '../../lib/snippets';
import './SettingsDialog.css';

export function SettingsDialog() {
  const [open, setOpen] = useState(false);
  const [settings, update] = useSettings();
  const { workspaceRoot } = useWorkspace();
  const memories = useMemories(workspaceRoot);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === 'Escape' && open) {
        setOpen(false);
      }
    };
    window.addEventListener('suxai:open-settings', onOpen);
    // v0.15.11 (audit-5 #3) — capture phase parity with the rest of
    // the app's hotkey handlers. Without it, Monaco could claim
    // Cmd+, first if the editor had focus.
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('suxai:open-settings', onOpen);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="settings__overlay" role="dialog" aria-modal="true" onClick={() => setOpen(false)}>
      <div className="settings__card glass-strong" onClick={(e) => e.stopPropagation()}>
        <div className="settings__head">
          <div>
            <div className="settings__title">Settings</div>
            <div className="settings__sub">Preferences saved locally on this device.</div>
          </div>
          <button
            type="button"
            className="settings__close"
            aria-label="Close"
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </div>

        <div className="settings__body">
          <Section title="Editor">
            <Row label="Font size">
              <input
                type="number"
                min={10}
                max={24}
                value={settings.fontSize}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  const clamped = Number.isFinite(n) ? Math.max(10, Math.min(24, n)) : 13;
                  update({ fontSize: clamped });
                }}
                className="settings__input"
              />
              <span className="settings__unit">px</span>
            </Row>
            <Row label="Tab size">
              <input
                type="number"
                min={1}
                max={8}
                value={settings.tabSize}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  const clamped = Number.isFinite(n) ? Math.max(1, Math.min(8, Math.trunc(n))) : 2;
                  update({ tabSize: clamped });
                }}
                className="settings__input"
              />
              <span className="settings__unit">spaces</span>
            </Row>
            <Row label="Word wrap">
              <Toggle
                value={settings.wordWrap}
                onChange={(v) => update({ wordWrap: v })}
              />
            </Row>
            <Row label="Minimap">
              <Toggle
                value={settings.minimap}
                onChange={(v) => update({ minimap: v })}
              />
            </Row>
            <Row label="Tab autocomplete">
              <Toggle
                value={settings.tabCompletion}
                onChange={(v) => update({ tabCompletion: v })}
              />
            </Row>
            <Row label="Auto-save (after delay)">
              <Toggle
                value={settings.autosave}
                onChange={(v) => update({ autosave: v })}
              />
            </Row>
            {settings.autosave && (
              <Row label="Auto-save delay">
                <input
                  type="number"
                  min={200}
                  max={10_000}
                  step={100}
                  value={settings.autosaveDelayMs}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    if (Number.isFinite(n)) update({ autosaveDelayMs: Math.max(200, Math.min(10_000, n)) });
                  }}
                  className="settings__input"
                />
                <span className="settings__unit">ms</span>
              </Row>
            )}
            <Row label="Format on save">
              <Toggle
                value={settings.formatOnSave}
                onChange={(v) => update({ formatOnSave: v })}
              />
            </Row>
            <Row label="Trim trailing whitespace on save">
              <Toggle
                value={settings.trimTrailingWhitespaceOnSave}
                onChange={(v) => update({ trimTrailingWhitespaceOnSave: v })}
              />
            </Row>
          </Section>

          <Section title="AI">
            <Row label="Default model">
              <select
                value={settings.defaultModelId}
                onChange={(e) => update({ defaultModelId: e.target.value })}
                className="settings__select"
              >
                {AI_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </Row>
            <Row label="Approval mode">
              <select
                value={settings.approvalMode}
                onChange={(e) => update({ approvalMode: e.target.value as 'auto' | 'step' | 'yolo' })}
                className="settings__select"
                title="Auto = file edits go to inline diff + commands prompt. Step = ask for everything. YOLO = auto-approve everything (file edits still appear in inline diff so you can roll back)."
              >
                <option value="auto">Auto (recommended)</option>
                <option value="step">Step (ask for every tool)</option>
                <option value="yolo">YOLO (auto-approve commands)</option>
              </select>
            </Row>
          </Section>

          <Section title={`Memories (${memories.length})`}>
            {memories.length === 0 ? (
              <div className="settings__hint">
                Aucune mémoire pour ce workspace. Utilise <code>/memory Title: content</code> dans le chat,
                ou laisse l'extraction automatique tourner après quelques messages.
              </div>
            ) : (
              <div className="settings__memories">
                {memories.map((m) => (
                  <div key={m.id} className="settings__memory">
                    <div className="settings__memory-body">
                      <div className="settings__memory-title">{m.title}</div>
                      <div className="settings__memory-content">{m.content}</div>
                    </div>
                    <button
                      type="button"
                      className="settings__memory-delete"
                      onClick={() => deleteMemory(workspaceRoot, m.id)}
                      title="Supprimer cette mémoire"
                      aria-label={`Supprimer ${m.title}`}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <McpSection />

          <SnippetsSection />
        </div>

        <div className="settings__foot">
          <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="settings__section">
      <div className="settings__section-title">{title}</div>
      <div className="settings__section-body">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="settings__row">
      <span className="settings__row-label">{label}</span>
      <div className="settings__row-control">{children}</div>
    </label>
  );
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      className={`settings__toggle ${value ? 'settings__toggle--on' : ''}`}
      onClick={() => onChange(!value)}
    >
      <span className="settings__toggle-thumb" />
    </button>
  );
}

/**
 * v0.16.11 — User snippets panel. Displays the count per language
 * scope ("*" = global) and gives the user the path to edit the JSON
 * directly. Inline form-based editor ships in a future release once
 * the JSON-edit workflow is validated.
 */
function SnippetsSection() {
  const map = useSnippets();
  const buckets = Object.entries(map);
  const total = buckets.reduce((acc, [, defs]) => acc + Object.keys(defs).length, 0);
  return (
    <div className="settings__section">
      <div className="settings__section-title">Snippets ({total})</div>
      <div className="settings__section-body">
        {total === 0 ? (
          <div className="settings__hint">
            No user snippets yet. Drop a JSON file at{' '}
            <code>userData/snippets.json</code> with the VSCode-compatible shape{' '}
            <code>{'{ "javascript": { "log": { "prefix": "log", "body": "console.log($1)" } } }'}</code>.
            Use <code>"*"</code> as the language key for snippets that apply everywhere.
            They surface in the autocomplete dropdown matching their language scope, with{' '}
            <code>$1</code> / <code>${'{1:default}'}</code> placeholders.
          </div>
        ) : (
          <ul className="settings__snippets-list">
            {buckets.map(([lang, defs]) => (
              <li key={lang} className="settings__snippets-bucket">
                <div className="settings__snippets-lang">
                  {lang === '*' ? 'global' : lang}
                  <span className="settings__snippets-count">{Object.keys(defs).length}</span>
                </div>
                <div className="settings__snippets-prefixes">
                  {Object.entries(defs).slice(0, 12).map(([name, def]) => (
                    <code key={name} className="settings__snippets-prefix" title={def.description ?? name}>
                      {def.prefix}
                    </code>
                  ))}
                  {Object.keys(defs).length > 12 && (
                    <span className="settings__snippets-more">+{Object.keys(defs).length - 12}</span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * v0.16.10 — MCP servers panel. Shows the list of configured servers
 * (read-only for foundations release) with their connection status
 * and a hint to the on-disk config path. Edit-by-form ships in a
 * later release once we've validated the wire protocol works in the
 * wild.
 */
function McpSection() {
  const servers = useMcpServers();
  const [configPath, setConfigPath] = useState<string>('');

  useEffect(() => {
    void readMcpConfig().then((res) => setConfigPath(res.path));
  }, []);

  const total = servers.length;
  const ready = servers.filter((s) => s.status === 'ready').length;

  return (
    <div className="settings__section">
      <div className="settings__section-title">
        MCP Servers ({ready}/{total} connected)
      </div>
      <div className="settings__section-body">
        {servers.length === 0 ? (
          <div className="settings__hint">
            No MCP server configured. Drop a JSON config at <code>{configPath || 'userData/mcp.json'}</code> with the shape{' '}
            <code>{'{ "servers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/your/folder"] } } }'}</code>{' '}
            then re-open Settings to see it appear here. Tools are discovered automatically once a server connects ; agent loop integration ships in a later version.
          </div>
        ) : (
          <ul className="settings__mcp-list">
            {servers.map((s) => (
              <li key={s.name} className={`settings__mcp settings__mcp--${s.status}`}>
                <div className="settings__mcp-row">
                  <span className={`settings__mcp-dot settings__mcp-dot--${s.status}`} aria-hidden />
                  <span className="settings__mcp-name">{s.name}</span>
                  <span className="settings__mcp-status">{s.status}</span>
                  <span className="settings__mcp-tools">
                    {s.toolCount > 0 ? `${s.toolCount} tool${s.toolCount > 1 ? 's' : ''}` : '—'}
                  </span>
                </div>
                <div className="settings__mcp-cmd" title={`${s.command} ${(s.args ?? []).join(' ')}`}>
                  <code>{s.command} {(s.args ?? []).join(' ')}</code>
                </div>
                {s.errorMsg && (
                  <div className="settings__mcp-err">{s.errorMsg.slice(0, 320)}</div>
                )}
              </li>
            ))}
          </ul>
        )}
        {configPath && (
          <div className="settings__hint" style={{ marginTop: 10, fontSize: 11 }}>
            Config file: <code>{configPath}</code>
          </div>
        )}
      </div>
    </div>
  );
}
