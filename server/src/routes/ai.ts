import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { aiRequestSchema, aiCompleteSchema, SUPPORTED_MODELS } from '../schemas/ai.js';
import { streamCompletion, completeFIM } from '../services/quatarly.service.js';
import { userStore } from '../store/users.js';
import { env } from '../config/env.js';

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
    const userId = req.user!.sub;

    // Enforce free-tier daily cap before opening the upstream stream.
    const usage = await userStore.getDailyUsage(userId);
    if (usage.tier === 'free' && usage.usedMs >= env.FREE_DAILY_LIMIT_MS) {
      res.status(402).json({
        message: 'Free daily limit reached. Redeem a license key or contact the owner to upgrade.',
        code: 'QUOTA_EXCEEDED',
        usedMs: usage.usedMs,
        limitMs: env.FREE_DAILY_LIMIT_MS,
      });
      return;
    }

    res.status(200);
    res.setHeader('content-type', 'text/event-stream');
    res.setHeader('cache-control', 'no-cache, no-transform');
    res.setHeader('connection', 'keep-alive');
    res.setHeader('x-accel-buffering', 'no');
    res.flushHeaders?.();

    const startedAt = Date.now();
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
      onToolUse: (call) => writeEvent({ tool_use: call }),
      onStop: (reason) => writeEvent({ stop_reason: reason }),
      onDone: () => writeDone(),
      onError: (err) => {
        writeEvent({ error: err.message });
        writeDone();
      },
    });

    // Track actual streaming duration against the user's daily budget.
    const elapsed = Date.now() - startedAt;
    userStore.trackUsage(userId, elapsed).catch((err) => {
      console.error('[ai] failed to track usage:', err);
    });
  },
);

// Tab autocomplete: separate rate limiter (much higher cap because
// every keystroke can trigger a request, debounced client-side).
// Free-tier daily quota still applies via the /ai/chat path which
// is where the real money goes.
const completeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 240, // 4/sec sustained — debounce 100ms client-side caps it well below
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Tab completion rate limit exceeded', code: 'RATE_LIMIT' },
});

router.post(
  '/complete',
  requireAuth,
  completeLimiter,
  validateBody(aiCompleteSchema),
  async (req, res) => {
    // Free-tier sanity check: if the user has already burned their
    // daily quota, skip silently. We don't want autocomplete to
    // surface 402s on every keystroke.
    const userId = req.user!.sub;
    const usage = await userStore.getDailyUsage(userId);
    if (usage.tier === 'free' && usage.usedMs >= env.FREE_DAILY_LIMIT_MS) {
      res.json({ completion: '' });
      return;
    }
    try {
      const completion = await completeFIM(req.body);
      res.json({ completion: completion ?? '' });
    } catch {
      // Never surface autocomplete failures to the client — they'd
      // pop up as a generic error toast every few seconds.
      res.json({ completion: '' });
    }
  },
);

export default router;
