import type { Request, Response, NextFunction } from 'express';
import { env } from '../config/env.js';

interface AppError extends Error {
  status?: number;
  code?: string;
  issues?: unknown;
}

export function notFound(_req: Request, res: Response) {
  res.status(404).json({ message: 'Not found', code: 'NOT_FOUND' });
}

export function errorHandler(
  err: AppError,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
) {
  const status = typeof err.status === 'number' ? err.status : 500;
  const body: Record<string, unknown> = {
    message: err.message || 'Internal server error',
    code: err.code ?? (status >= 500 ? 'INTERNAL' : 'ERROR'),
  };
  if (err.issues) body.issues = err.issues;
  if (env.NODE_ENV !== 'production' && status >= 500) body.stack = err.stack;

  if (status >= 500) console.error('[error]', err);
  res.status(status).json(body);
}
