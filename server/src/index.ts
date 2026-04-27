import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
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

app.get('/health', (_req, res) => res.json({ ok: true, version: env.UPDATE_VERSION }));

// Auth endpoints only need small payloads (credentials, refresh tokens,
// license keys). Capping at 4 KB prevents bandwidth-waste attacks
// against the login endpoint where a 64 MB body would parse before
// schema validation runs.
app.use('/auth', express.json({ limit: '4kb' }), authRouter);

// Update endpoint is GET-only — body parser not needed.
app.use('/update', updateRouter);

// AI routes carry large attachments (agent context, file contents).
// 64 MB outer cap; per-field Zod limits are the real safety net.
app.use('/ai', express.json({ limit: '64mb' }), aiRouter);

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
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  process.exit(1);
});
