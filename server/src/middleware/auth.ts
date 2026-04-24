import type { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, type AccessClaims } from '../utils/token.js';

declare global {
  namespace Express {
    interface Request {
      user?: AccessClaims;
    }
  }
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return next(Object.assign(new Error('Missing bearer token'), { status: 401, code: 'AUTH_REQUIRED' }));
  }
  const token = header.slice(7).trim();
  try {
    req.user = verifyAccessToken(token);
    next();
  } catch {
    next(Object.assign(new Error('Invalid or expired token'), { status: 401, code: 'AUTH_INVALID' }));
  }
}
