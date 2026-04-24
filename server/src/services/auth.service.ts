import crypto from 'node:crypto';
import { userStore, type UserRecord } from '../store/users.js';
import { licenseStore } from '../store/licenses.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../utils/token.js';

export interface PublicUser {
  id: string;
  email: string;
  username: string;
  tier: 'free' | 'pro';
}

export interface AuthResult {
  token: string;
  refreshToken: string;
  user: PublicUser;
}

function toPublic(user: UserRecord): PublicUser {
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    tier: user.tier,
  };
}

function buildTokens(user: UserRecord): AuthResult {
  const token = signAccessToken({ sub: user.id, email: user.email });
  const refreshToken = signRefreshToken({ sub: user.id, jti: crypto.randomUUID() });
  return { token, refreshToken, user: toPublic(user) };
}

export const authService = {
  async register(email: string, password: string, username: string): Promise<AuthResult> {
    const passwordHash = await hashPassword(password);
    const user = await userStore.create({ email, username, passwordHash });
    return buildTokens(user);
  },

  async login(email: string, password: string): Promise<AuthResult> {
    const user = await userStore.findByEmail(email);
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

  async me(userId: string): Promise<PublicUser & { usedMs: number }> {
    const user = await userStore.findById(userId);
    if (!user) {
      throw Object.assign(new Error('User not found'), { status: 404, code: 'NOT_FOUND' });
    }
    const { usedMs } = await userStore.getDailyUsage(userId);
    return { ...toPublic(user), usedMs };
  },

  async redeemLicense(userId: string, key: string): Promise<PublicUser> {
    const license = await licenseStore.findByKey(key);
    if (!license) {
      throw Object.assign(new Error('Invalid license key'), {
        status: 404,
        code: 'LICENSE_NOT_FOUND',
      });
    }
    await licenseStore.redeem(key, userId);
    const updated = await userStore.setTier(userId, 'pro');
    if (!updated) {
      throw Object.assign(new Error('User not found'), { status: 404, code: 'NOT_FOUND' });
    }
    return toPublic(updated);
  },
};
