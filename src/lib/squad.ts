/**
 * v4.0 — Squad multi-agent orchestrator.
 *
 * Plusieurs agents Claude tournent en parallèle sur le même prompt
 * + contexte file, chacun avec un rôle spécialisé (architect /
 * auditor / improver). Chaque agent utilise sa propre instance de
 * `streamAi` ; le SquadModal render les N colonnes côte-à-côte avec
 * leur contenu qui apparaît en live.
 *
 * Pas de coordination cross-agent dans cette V4.0 : chaque agent
 * est indépendant, il y a pas de master de synthèse. V4.1 pourrait
 * ajouter un master qui prend les N reports et fait une fusion.
 */

import { streamAi } from '../api/quatarly';

export interface SquadAgentSpec {
  id: string;
  label: string;
  glyph: string;
  /** Couleur de palette pour le card (token CSS). */
  accent: 'bronze' | 'honey' | 'sage' | 'terra' | 'slate';
  /** Suffix appended to the user prompt to specialize the agent. */
  promptSuffix: string;
}

export const SQUAD_AGENTS: SquadAgentSpec[] = [
  {
    id: 'architect',
    label: 'Architect',
    glyph: '🏛️',
    accent: 'bronze',
    promptSuffix:
      `\n\n---\n\nYou are the **Architect** of a code-review squad. Your role :\n` +
      `- Analyse the high-level structure : modules, boundaries, layering, design patterns.\n` +
      `- Identify architectural smells (god objects, circular deps, leaky abstractions, missing seams).\n` +
      `- Map the data + control flow at a 30,000 ft view, NOT line-by-line.\n` +
      `- Recommend structural changes (extract module, reverse dependency, introduce port).\n\n` +
      `Format your reply as 3 short sections : « Structure », « Smells », « Recommendations ». ` +
      `Be concrete and reference real symbols/files. No prose preamble.`,
  },
  {
    id: 'auditor',
    label: 'Auditor',
    glyph: '🔍',
    accent: 'terra',
    promptSuffix:
      `\n\n---\n\nYou are the **Auditor** of a code-review squad. Your role :\n` +
      `- Hunt bugs, security holes (injection, XSS, path traversal, auth bypass), unsafe defaults.\n` +
      `- Surface edge cases the code mishandles (empty arrays, null, race conditions, error swallowing).\n` +
      `- Flag any pattern that could leak secrets / PII / tokens.\n` +
      `- Note missing input validation at trust boundaries.\n\n` +
      `Format : numbered list of findings. For each, give « Severity (high/med/low) · Location · Issue · Fix ». ` +
      `If everything looks clean, say so explicitly. No prose preamble.`,
  },
  {
    id: 'improver',
    label: 'Improver',
    glyph: '⚡',
    accent: 'honey',
    promptSuffix:
      `\n\n---\n\nYou are the **Improver** of a code-review squad. Your role :\n` +
      `- Suggest concrete, actionable improvements : performance, readability, ergonomics, maintainability.\n` +
      `- Propose modern patterns where the code uses outdated ones (callbacks → async/await, classes → composables, etc.).\n` +
      `- Identify dead code, redundant work, premature abstractions.\n` +
      `- Suggest tests where coverage is thin.\n\n` +
      `Format : ranked list of suggestions, highest-impact first. Each with « Win · Effort · Diff sketch (3-5 lines max) ». ` +
      `No prose preamble.`,
  },
  {
    id: 'performance',
    label: 'Performance',
    glyph: '🚀',
    accent: 'sage',
    promptSuffix:
      `\n\n---\n\nYou are the **Performance** specialist of a code-review squad. Your role :\n` +
      `- Identify hot paths and quantify their cost (Big-O, allocations per call, memory churn).\n` +
      `- Flag wasteful patterns : N+1 queries, repeated parsing, unbounded loops, sync I/O on hot path.\n` +
      `- Spot needless re-renders / re-computations (React useMemo missing, useCallback churn, prop drilling).\n` +
      `- Suggest concrete optimisations with expected speedup (« 10ms → 0.5ms because we eliminate the parse »).\n\n` +
      `Format : ranked findings, highest impact first. Each with « Hot path · Current cost · Optimised cost · Fix ». ` +
      `If perf is fine, say so explicitly. No prose preamble.`,
  },
  {
    id: 'security',
    label: 'Security',
    glyph: '🛡️',
    accent: 'slate',
    promptSuffix:
      `\n\n---\n\nYou are the **Security** specialist of a code-review squad. Your role :\n` +
      `- Hunt OWASP top 10 patterns : injection, broken auth, XSS, IDOR, SSRF, deserialisation, etc.\n` +
      `- Flag secrets in code (keys, tokens, passwords, signing material).\n` +
      `- Audit input validation at trust boundaries (HTTP, IPC, file uploads, env vars).\n` +
      `- Check crypto usage : weak algos, hardcoded IVs, predictable randomness, missing constant-time compare.\n\n` +
      `Format : findings table with « CVSS-est · CWE · Vector · Exploit scenario · Mitigation ». ` +
      `If everything's clean, say so AND list what you specifically checked. No prose preamble.`,
  },
];

/**
 * v4.1 — Master synthesis agent. Runs AFTER all the role agents
 * have completed, takes their reports as input, produces a single
 * prioritised action plan. Spec is separate from SQUAD_AGENTS
 * because it's run sequentially, not in parallel with the others.
 */
export const SQUAD_MASTER: SquadAgentSpec = {
  id: 'master',
  label: 'Master',
  glyph: '🎩',
  accent: 'bronze',
  promptSuffix:
    `\n\n---\n\nYou are the **Master** synthesizer of a code-review squad. ` +
    `You receive the reports from 5 specialist agents (Architect, Auditor, Improver, Performance, Security). ` +
    `Your role :\n` +
    `- De-duplicate findings (same issue mentioned by multiple agents).\n` +
    `- Rank everything by IMPACT × EFFORT (high impact, low effort first).\n` +
    `- Produce a single ordered action plan, max 8 items.\n` +
    `- For each item : « Title · Why it matters · Effort (S/M/L) · Concrete next step ».\n\n` +
    `If reports disagree, surface the disagreement and pick a side with reasoning. ` +
    `If the code is in great shape, say so explicitly with what you'd watch for as it grows. ` +
    `No prose preamble.`,
};

export interface SquadAgentState {
  spec: SquadAgentSpec;
  status: 'queued' | 'streaming' | 'done' | 'error';
  content: string;
  error?: string;
  /** ms epoch — quand le stream a démarré. Utile pour afficher le
   *  timing total et le throughput tokens/sec. */
  startedAt?: number;
  doneAt?: number;
}

export interface SquadRunArgs {
  token: string;
  modelId: string;
  prompt: string;
  context?: {
    filePath?: string;
    language?: string;
    fileContent?: string;
    selection?: string;
  };
  agents?: SquadAgentSpec[];
  onUpdate: (state: SquadAgentState) => void;
}

export interface MasterSynthArgs {
  token: string;
  modelId: string;
  /** Original user prompt that drove the squad. */
  userPrompt: string;
  /** All completed agent reports (ignore those still streaming/error). */
  reports: Array<{ spec: SquadAgentSpec; content: string }>;
  onUpdate: (state: SquadAgentState) => void;
}

/**
 * Spawn N parallel streams, one per agent. Each stream's tokens are
 * pushed to `onUpdate` as they arrive ; final state is also pushed
 * with status='done' on completion or 'error' on failure.
 *
 * Returns a single abort function that cancels ALL in-flight streams.
 */
export function runSquad(args: SquadRunArgs): () => void {
  const agents = args.agents ?? SQUAD_AGENTS;
  const aborts: Array<() => void> = [];

  for (const spec of agents) {
    let buf = '';
    const startedAt = Date.now();
    args.onUpdate({ spec, status: 'streaming', content: '', startedAt });

    const cancel = streamAi(
      args.token,
      {
        modelId: args.modelId,
        command: 'chat',
        prompt: args.prompt + spec.promptSuffix,
        context: args.context,
      },
      {
        onToken: (chunk) => {
          buf += chunk;
          args.onUpdate({ spec, status: 'streaming', content: buf, startedAt });
        },
        onDone: () => {
          args.onUpdate({
            spec,
            status: 'done',
            content: buf,
            startedAt,
            doneAt: Date.now(),
          });
        },
        onError: (err) => {
          args.onUpdate({
            spec,
            status: 'error',
            content: buf,
            error: err.message,
            startedAt,
            doneAt: Date.now(),
          });
        },
      },
    );
    aborts.push(cancel);
  }

  return () => aborts.forEach((c) => c());
}

/**
 * v4.1 — Run the Master synthesis agent. Called AFTER all role
 * agents have produced reports. Master gets the user's original
 * prompt + each role's report concatenated as input, and produces
 * a single prioritised action plan.
 */
export function runMaster(args: MasterSynthArgs): () => void {
  const spec = SQUAD_MASTER;
  let buf = '';
  const startedAt = Date.now();
  args.onUpdate({ spec, status: 'streaming', content: '', startedAt });

  const reportsBlock = args.reports
    .map((r) => `## ${r.spec.label} ${r.spec.glyph}\n\n${r.content}`)
    .join('\n\n---\n\n');
  const masterPrompt =
    `Original user prompt :\n\n${args.userPrompt}\n\n` +
    `===\n\nReports from the squad :\n\n${reportsBlock}` +
    spec.promptSuffix;

  return streamAi(
    args.token,
    {
      modelId: args.modelId,
      command: 'chat',
      prompt: masterPrompt,
    },
    {
      onToken: (chunk) => {
        buf += chunk;
        args.onUpdate({ spec, status: 'streaming', content: buf, startedAt });
      },
      onDone: () => {
        args.onUpdate({
          spec,
          status: 'done',
          content: buf,
          startedAt,
          doneAt: Date.now(),
        });
      },
      onError: (err) => {
        args.onUpdate({
          spec,
          status: 'error',
          content: buf,
          error: err.message,
          startedAt,
          doneAt: Date.now(),
        });
      },
    },
  );
}
