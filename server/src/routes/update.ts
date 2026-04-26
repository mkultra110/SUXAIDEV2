import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { env } from '../config/env.js';

const router = Router();

// v0.15.10 (audit-4 #4) — dedicated rate-limit on the public,
// unauthenticated /manifest endpoint. The global Express limiter
// (300/min) is too generous for an endpoint anybody on the internet
// can spam. 60 req/min per IP is plenty for a polling client (default
// poll is once every 30 minutes).
const manifestLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Update manifest rate limit exceeded', code: 'RATE_LIMIT' },
});

router.get('/manifest', manifestLimiter, (_req, res) => {
  const manifest: Record<string, unknown> = {
    version: env.UPDATE_VERSION,
    url: env.UPDATE_URL,
  };
  if (env.UPDATE_NOTES) manifest.notes = env.UPDATE_NOTES;
  if (env.UPDATE_SHA256) manifest.sha256 = env.UPDATE_SHA256;
  if (env.UPDATE_SIZE > 0) manifest.size = env.UPDATE_SIZE;
  // no-store + must-revalidate prevents intermediaries from serving a
  // stale manifest if they can't reach the origin, so a stuck cache
  // can't gate users away from a critical update.
  res.setHeader('cache-control', 'no-store, must-revalidate, max-age=0');
  res.json(manifest);
});

export default router;
