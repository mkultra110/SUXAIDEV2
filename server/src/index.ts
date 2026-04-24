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
// 10 MB is plenty for even a fat attachment + full file context. Upstream
// providers reject sooner than this anyway. The prompt schema's per-field
// caps are the real safety net.
app.use(express.json({ limit: '10mb' }));

// Global soft-limit to protect against bursts.
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
  }),
);

app.get('/health', (_req, res) => res.json({ ok: true, version: env.UPDATE_VERSION }));

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
