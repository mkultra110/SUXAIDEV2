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
    username: user.username,
    tier: user.tier,
  };
}

function buildTokens(user: UserRecord): AuthResult {
  const token = signAccessToken({ sub: user.id, username: user.username });
  const refreshToken = signRefreshToken({ sub: user.id, jti: crypto.randomUUID() });
  return { token, refreshToken, user: toPublic(user) };
}

// Pre-computed bcrypt hash of a randomly-generated dummy password.
// Used as the comparison target when the username doesn't exist so
// login() takes the same wall time whether or not the account is real.
// Without this, an attacker can probe usernames by measuring response
// latency: ~200 ms when bcrypt.compare runs vs <1 ms when the early
// return triggers. The dummy hash is generated lazily at first use.
let dummyHashCache: string | null = null;
async function getDummyHash(): Promise<string> {
  if (dummyHashCache) return dummyHashCache;
  // 32 random bytes hex-encoded — guaranteed to never match any real
  // password. Hashed at module rounds so the wall time matches.
  const filler = crypto.randomBytes(32).toString('hex');
  dummyHashCache = await hashPassword(filler);
  return dummyHashCache;
}

export const authService = {
  async register(username: string, password: string): Promise<AuthResult> {
    const passwordHash = await hashPassword(password);
    const user = await userStore.create({ username, passwordHash });
    return buildTokens(user);
  },

  async login(username: string, password: string): Promise<AuthResult> {
    const user = await userStore.findByUsername(username);
    const invalid = () =>
      Object.assign(new Error('Invalid username or password'), {
        status: 401,
        code: 'INVALID_CREDENTIALS',
      });

    // Always run bcrypt.compare so the response time is constant
    // regardless of whether the username exists. Throwing the same
    // generic 'invalid' error in either branch closes the user-
    // enumeration side-channel.
    const hashToCompare = user?.passwordHash ?? (await getDummyHash());
    const ok = await verifyPassword(password, hashToCompare);
    if (!user || !ok) throw invalid();
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
    // Single-step redeem: the store enqueues an atomic write that
    // atomically (a) verifies the key exists, (b) verifies it's not
    // already redeemed, (c) marks it redeemed by this user. A
    // pre-flight findByKey would only create a TOCTOU window where two
    // simultaneous requests could both pass the check, then both try
    // to redeem.
    let updated: import('../store/licenses.js').LicenseRecord | null;
    try {
      updated = await licenseStore.redeem(key, userId);
    } catch (err) {
      // Re-throw 409 ALREADY_REDEEMED unchanged.
      throw err;
    }
    if (!updated) {
      throw Object.assign(new Error('Invalid license key'), {
        status: 404,
        code: 'LICENSE_NOT_FOUND',
      });
    }
    const updatedUser = await userStore.setTier(userId, 'pro');
    if (!updatedUser) {
      // The license is now spent against a missing user. We don't roll
      // it back automatically — flag the inconsistency loudly so an
      // operator can refund the key manually.
      console.error(
        `[auth] license ${key} redeemed for missing user ${userId} — manual review needed`,
      );
      throw Object.assign(new Error('User not found'), { status: 404, code: 'NOT_FOUND' });
    }
    return toPublic(updatedUser);
  },
};
