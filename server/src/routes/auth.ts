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

router.post('/register', authLimiter, validateBody(registerSchema), authController.register);
router.post('/login', authLimiter, validateBody(loginSchema), authController.login);
router.post('/refresh', authLimiter, validateBody(refreshSchema), authController.refresh);
router.get('/me', requireAuth, authController.me);
router.post(
  '/redeem-license',
  requireAuth,
  validateBody(redeemLicenseSchema),
  authController.redeemLicense,
);

export default router;
