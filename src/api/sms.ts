/**
 * v5.2 — Client wrapper for /sms/* routes.
 *
 * Routes through the SUXAI server (which holds the 1001SMS API key).
 * The client never sees the upstream key.
 *
 * All methods return parsed JSON `{ ok, data }` on success or throw
 * with a friendly message on failure (matches the server contract).
 */
import { API_BASE_URL } from '../config';
import { tryRefreshToken } from './client';

interface Envelope<T> { ok: boolean; data?: T; error?: string; status?: number; code?: string }

async function call<T>(
  token: string | null,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  if (!token) throw new Error('Not authenticated');
  const doFetch = (jwt: string) =>
    fetch(`${API_BASE_URL}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${jwt}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  let res = await doFetch(token);
  if (res.status === 401) {
    try { await res.text(); } catch { /* drain */ }
    const fresh = await tryRefreshToken();
    if (fresh) res = await doFetch(fresh);
  }
  let env: Envelope<T> | null = null;
  try { env = (await res.json()) as Envelope<T>; } catch { /* */ }
  if (!res.ok || !env || env.ok === false) {
    const msg = env?.error || `HTTP ${res.status}`;
    throw Object.assign(new Error(msg), { status: res.status, code: env?.code });
  }
  return env.data as T;
}

export interface SmsConfigured { configured: boolean }
export interface SmsService { slug: string; name?: string; [k: string]: unknown }
export interface SmsCountry { code: string; name?: string; [k: string]: unknown }
export interface SmsOrder { orderId?: string; phone?: string; [k: string]: unknown }
export interface SmsBalance { balance?: number; currency?: string; [k: string]: unknown }

export const smsApi = {
  configured: (token: string | null) => call<SmsConfigured>(token, 'GET', '/sms/configured'),
  services: (token: string | null) => call<SmsService[]>(token, 'GET', '/sms/services'),
  countries: (token: string | null) => call<SmsCountry[]>(token, 'GET', '/sms/countries'),
  pricing: (token: string | null, q: { country?: string; service?: string }) => {
    const params = new URLSearchParams();
    if (q.country) params.set('country', q.country);
    if (q.service) params.set('service', q.service);
    const qs = params.toString();
    return call<unknown>(token, 'GET', `/sms/pricing${qs ? `?${qs}` : ''}`);
  },
  balance: (token: string | null) => call<SmsBalance>(token, 'GET', '/sms/balance'),
  order: (
    token: string | null,
    body: { country: string; service: string; provider: string; purchaseType: string },
  ) => call<SmsOrder>(token, 'POST', '/sms/order', body),
  check: (token: string | null, orderId: string) =>
    call<unknown>(token, 'POST', '/sms/check', { orderId }),
  cancel: (token: string | null, orderId: string) =>
    call<unknown>(token, 'POST', '/sms/cancel', { orderId }),
  cancelAll: (token: string | null) => call<unknown>(token, 'POST', '/sms/cancel-all'),
  active: (token: string | null, q: { page?: number; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (q.page) params.set('page', String(q.page));
    if (q.limit) params.set('limit', String(q.limit));
    const qs = params.toString();
    return call<unknown>(token, 'GET', `/sms/active${qs ? `?${qs}` : ''}`);
  },
  history: (
    token: string | null,
    q: { page?: number; limit?: number; status?: string; from?: string; to?: string } = {},
  ) => {
    const params = new URLSearchParams();
    if (q.page) params.set('page', String(q.page));
    if (q.limit) params.set('limit', String(q.limit));
    if (q.status) params.set('status', q.status);
    if (q.from) params.set('from', q.from);
    if (q.to) params.set('to', q.to);
    const qs = params.toString();
    return call<unknown>(token, 'GET', `/sms/history${qs ? `?${qs}` : ''}`);
  },
  archiveAll: (token: string | null) => call<unknown>(token, 'GET', '/sms/archive-all'),
  details: (token: string | null, orderId: string) =>
    call<unknown>(token, 'GET', `/sms/order/${encodeURIComponent(orderId)}`),
};
