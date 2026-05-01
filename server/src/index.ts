import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { statfs } from 'node:fs/promises';
import { env, corsOrigins } from './config/env.js';
import authRouter from './routes/auth.js';
import aiRouter from './routes/ai.js';
import updateRouter from './routes/update.js';
import { errorHandler, notFound } from './middleware/error.js';

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(
  helmet({
    // Strong defaults: HSTS for HTTPS-only, deny framing entirely
    // (we never embed the API in any iframe), and strict referrer.
    // CORP stays cross-origin so the Electron renderer can stream from
    // /ai/chat under a different origin.
    strictTransportSecurity: {
      maxAge: 60 * 60 * 24 * 365, // 1 year
      includeSubDomains: true,
      preload: true,
    },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  }),
);
app.use(
  cors({
    origin: corsOrigins,
    credentials: true,
    allowedHeaders: ['content-type', 'authorization', 'accept'],
  }),
);

// Global soft-limit to protect against bursts. Runs BEFORE the body
// parser so a flood of 10 MB POSTs gets rejected at 429 without
// consuming memory parsing the JSON. Order matters: helmet/cors only
// add headers; rate-limit must precede body parsing.
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  }),
);

// 64 MB body limit (v0.11.1, was 32 MB). Lets a single agent turn
// carry several big attachments (8 MB per block × a handful of
// files) plus a long rolling tool history without hitting 413.
// The per-field zod caps in server/src/schemas/ai.ts remain the
// real safety net; this value is the outer wall so the JSON
// parser doesn't blow up before schema validation can give a
// precise error.
app.use(express.json({ limit: '64mb' }));

// v4.3.0 — health endpoint enrichi : on remonte mémoire, uptime, et
// surtout l'espace disque libre sur DATA_DIR (la cible des écritures
// users.json + backups). Permet à un monitor externe de couper avant
// que ENOSPC ne fige le serveur en restart-loop comme on l'a vu en
// prod le 2026-05-01.
app.get('/health', async (_req, res) => {
  const mem = process.memoryUsage();
  let disk: { totalMB: number; freeMB: number; usedPct: number } | null = null;
  try {
    const s = await statfs(env.DATA_DIR);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    disk = {
      totalMB: Math.round(total / (1024 * 1024)),
      freeMB: Math.round(free / (1024 * 1024)),
      usedPct: total > 0 ? Math.round(((total - free) / total) * 100) : 0,
    };
  } catch {
    /* statfs indisponible — laisse disk=null */
  }
  // Considère la santé dégradée si <500MB libres OU >95% utilisé.
  // Le client peut alors basculer en mode read-only / alerter.
  const degraded = !!(disk && (disk.freeMB < 500 || disk.usedPct > 95));
  res.status(degraded ? 503 : 200).json({
    ok: !degraded,
    version: env.UPDATE_VERSION,
    uptimeSec: Math.round(process.uptime()),
    memoryMB: {
      rss: Math.round(mem.rss / (1024 * 1024)),
      heapUsed: Math.round(mem.heapUsed / (1024 * 1024)),
    },
    disk,
    ...(degraded ? { warning: 'Disk space critical — writes may fail' } : {}),
  });
});

app.use('/auth', authRouter);
app.use('/ai', aiRouter);
app.use('/update', updateRouter);

app.use(notFound);
app.use(errorHandler);

const server = app.listen(env.PORT, env.HOST, () => {
  console.log(`[suxai] listening on http://${env.HOST}:${env.PORT} (${env.NODE_ENV})`);
});

function shutdown(signal: string) {
  console.log(`[suxai] received ${signal}, shutting down…`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
});
