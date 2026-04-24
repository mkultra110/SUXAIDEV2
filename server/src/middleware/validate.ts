import type { Request, Response, NextFunction } from 'express';
import { ZodError, type ZodSchema } from 'zod';

export function validateBody<T>(schema: ZodSchema<T>) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        next(
          Object.assign(new Error(err.issues[0]?.message ?? 'Validation error'), {
            status: 400,
            code: 'VALIDATION_ERROR',
            issues: err.issues,
          }),
        );
        return;
      }
      next(err);
    }
  };
}
