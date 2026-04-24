import type { Request, Response, NextFunction } from 'express';
import { authService } from '../services/auth.service.js';
import type { CredentialsInput, RefreshInput } from '../schemas/auth.js';

export const authController = {
  async register(req: Request<unknown, unknown, CredentialsInput>, res: Response, next: NextFunction) {
    try {
      const { email, password } = req.body;
      const result = await authService.register(email, password);
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  },

  async login(req: Request<unknown, unknown, CredentialsInput>, res: Response, next: NextFunction) {
    try {
      const { email, password } = req.body;
      const result = await authService.login(email, password);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },

  async refresh(req: Request<unknown, unknown, RefreshInput>, res: Response, next: NextFunction) {
    try {
      const result = await authService.refresh(req.body.refreshToken);
      res.json(result);
    } catch (err) {
      next(err);
    }
  },

  async me(req: Request, res: Response, next: NextFunction) {
    try {
      const user = await authService.me(req.user!.sub);
      res.json(user);
    } catch (err) {
      next(err);
    }
  },
};
