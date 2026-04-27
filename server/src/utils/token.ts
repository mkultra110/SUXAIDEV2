import jwt from 'jsonwebtoken';
import type { SignOptions } from 'jsonwebtoken';
import { env } from '../config/env.js';

export interface AccessClaims {
  sub: string;
  username: string;
  type: 'access';
}

export interface RefreshClaims {
  sub: string;
  type: 'refresh';
  jti: string;
}

export function signAccessToken(payload: Omit<AccessClaims, 'type'>): string {
  const opts: SignOptions = { algorithm: 'HS256', expiresIn: env.JWT_ACCESS_TTL as SignOptions['expiresIn'] };
  return jwt.sign({ ...payload, type: 'access' }, env.JWT_SECRET, opts);
}

export function signRefreshToken(payload: Omit<RefreshClaims, 'type'>): string {
  const opts: SignOptions = { algorithm: 'HS256', expiresIn: env.JWT_REFRESH_TTL as SignOptions['expiresIn'] };
  return jwt.sign({ ...payload, type: 'refresh' }, env.JWT_SECRET, opts);
}

export function verifyAccessToken(token: string): AccessClaims {
  const decoded = jwt.verify(token, env.JWT_SECRET) as AccessClaims;
  if (decoded.type !== 'access') throw new Error('Invalid token type');
  return decoded;
}

export function verifyRefreshToken(token: string): RefreshClaims {
  const decoded = jwt.verify(token, env.JWT_SECRET) as RefreshClaims;
  if (decoded.type !== 'refresh') throw new Error('Invalid token type');
  return decoded;
}
