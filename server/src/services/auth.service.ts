import crypto from 'node:crypto';
import { userStore, type UserRecord } from '../store/users.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../utils/token.js';

export interface AuthResult {
  token: string;
  refreshToken: string;
  user: { id: string; email: string };
}

function toPublic(user: UserRecord) {
  return { id: user.id, email: user.email };
}

function buildTokens(user: UserRecord): AuthResult {
  const token = signAccessToken({ sub: user.id, email: user.email });
  const refreshToken = signRefreshToken({ sub: user.id, jti: crypto.randomUUID() });
  return { token, refreshToken, user: toPublic(user) };
}

export const authService = {
  async register(email: string, password: string): Promise<AuthResult> {
    const passwordHash = await hashPassword(password);
    const user = await userStore.create({ email, passwordHash });
    return buildTokens(user);
  },

  async login(email: string, password: string): Promise<AuthResult> {
    const user = await userStore.findByEmail(email);
    // Uniform error to avoid user enumeration.
    const invalid = () =>
      Object.assign(new Error('Invalid email or password'), {
        status: 401,
        code: 'INVALID_CREDENTIALS',
      });

    if (!user) throw invalid();
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) throw invalid();
    return buildTokens(user);
  },

  async refresh(refreshToken: string): Promise<AuthResult> {
    let claims;
    try {
      claims = verifyRefreshToken(refreshToken);
    } catch {
      throw Object.assign(new Error('Invalid refresh token'), {
        status: 401,
        code: 'REFRESH_INVALID',
      });
    }
    const user = await userStore.findById(claims.sub);
    if (!user) {
      throw Object.assign(new Error('User no longer exists'), {
        status: 401,
        code: 'USER_GONE',
      });
    }
    return buildTokens(user);
  },

  async me(userId: string) {
    const user = await userStore.findById(userId);
    if (!user) {
      throw Object.assign(new Error('User not found'), { status: 404, code: 'NOT_FOUND' });
    }
    return toPublic(user);
  },
};
