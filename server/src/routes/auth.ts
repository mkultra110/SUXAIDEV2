import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { authController } from '../controllers/auth.controller.js';
import { validateBody } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import {
  loginSchema,
  registerSchema,
  refreshSchema,
  redeemLicenseSchema,
} from '../schemas/auth.js';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many attempts, please try again later', code: 'RATE_LIMIT' },
});

// v0.12.4 (audit #15): targeted credential-stuffing defense. The
// per-IP limiter above caps 20 attempts / 15 min — fine against a
// single attacker, useless against a botnet rotating IPs across many
// users. We layer a per-username throttle on /login: 5 attempts /
// minute, keyed on the email field of the request body. Wrong
// passwords on the same account from any source pile into the same
// bucket. Legitimate user retries are unaffected (typo + retry =
// 2/min).
const loginUserLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  // Skip when validation hasn't run yet (no body parsed) — falls
  // back to the global IP-keyed bucket. Otherwise key on the email
  // (already lowercased / trimmed by zod via loginSchema).
  keyGenerator: (req) => {
    const email = (req.body as { email?: unknown } | undefined)?.email;
    if (typeof email === 'string' && email.length > 0) {
      return `login:${email.toLowerCase()}`;
    }
    return `login:ip:${req.ip ?? 'unknown'}`;
  },
  message: { message: 'Too many login attempts on this account', code: 'RATE_LIMIT_USER' },
});

router.post('/register', authLimiter, validateBody(registerSchema), authController.register);
router.post('/login', authLimiter, validateBody(loginSchema), loginUserLimiter, authController.login);
router.post('/refresh', authLimiter, validateBody(refreshSchema), authController.refresh);
router.get('/me', requireAuth, authController.me);
router.post(
  '/redeem-license',
  requireAuth,
  validateBody(redeemLicenseSchema),
  authController.redeemLicense,
);

export default router;
