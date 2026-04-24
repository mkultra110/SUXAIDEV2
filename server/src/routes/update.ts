import { Router } from 'express';
import { env } from '../config/env.js';

const router = Router();

router.get('/manifest', (_req, res) => {
  const manifest: Record<string, unknown> = {
    version: env.UPDATE_VERSION,
    url: env.UPDATE_URL,
  };
  if (env.UPDATE_NOTES) manifest.notes = env.UPDATE_NOTES;
  if (env.UPDATE_SHA256) manifest.sha256 = env.UPDATE_SHA256;
  if (env.UPDATE_SIZE > 0) manifest.size = env.UPDATE_SIZE;
  res.setHeader('cache-control', 'no-cache');
  res.json(manifest);
});

export default router;
