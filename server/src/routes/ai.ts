import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { aiRequestSchema, SUPPORTED_MODELS } from '../schemas/ai.js';
import { streamCompletion } from '../services/quatarly.service.js';

const router = Router();

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'AI rate limit exceeded', code: 'RATE_LIMIT' },
});

router.get('/models', requireAuth, (_req, res) => {
  res.json({
    models: SUPPORTED_MODELS.map(({ id, provider, label }) => ({ id, provider, label })),
  });
});

router.post(
  '/chat',
  requireAuth,
  aiLimiter,
  validateBody(aiRequestSchema),
  async (req, res) => {
    res.status(200);
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no'); // disable nginx buffering
    res.flushHeaders?.();

    let closed = false;
    const writeEvent = (obj: unknown) => {
      if (closed) return;
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    const writeDone = () => {
      if (closed) return;
      res.write('data: [DONE]\n\n');
      res.end();
      closed = true;
    };

    req.on('close', () => {
      closed = true;
    });

    await streamCompletion(req.body, {
      onDelta: (delta) => writeEvent({ delta }),
      onDone: () => writeDone(),
      onError: (err) => {
        writeEvent({ error: err.message });
        writeDone();
      },
    });
  },
);

export default router;
