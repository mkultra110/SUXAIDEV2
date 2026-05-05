/**
 * v5.2 — 1001SMS upstream wrapper.
 *
 * Wraps https://www.1001sms.com/api/v1/* with typed methods. The API
 * key (getApiKey()) is sent as `Authorization: Bearer <key>`
 * and never leaks to clients — `/sms/*` routes proxy through this
 * service.
 *
 * All methods throw `SmsUpstreamError` on non-2xx so the route layer
 * can surface a consistent error envelope to the client. Network /
 * timeout failures bubble as plain Error.
 */
import { env } from '../config/env.js';

// v5.2.1 — accept SUXAVOIP_API_KEY first, fall back to legacy
// SMS1001_API_KEY for VPS deployed before the rebrand.
function getApiKey(): string {
  return env.SUXAVOIP_API_KEY || env.SMS1001_API_KEY || '';
}
function getBaseUrl(): string {
  return env.SUXAVOIP_BASE_URL || env.SMS1001_BASE_URL;
}

export class SmsUpstreamError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
    this.name = 'SmsUpstreamError';
  }
}

const TIMEOUT_MS = 15_000;

export interface SmsService { slug: string; name?: string; [k: string]: unknown }
export interface SmsCountry { code: string; name?: string; [k: string]: unknown }
export interface SmsOrder { orderId?: string; phone?: string; [k: string]: unknown }
export interface SmsBalance { balance?: number; currency?: string; [k: string]: unknown }

interface Envelope<T> { success: boolean; data?: T; error?: string }

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
): Promise<T> {
  if (!getApiKey()) {
    throw new SmsUpstreamError(
      'SUXAVOIP_API_KEY not configured on the server',
      503,
      'NOT_CONFIGURED',
    );
  }
  const url = `${getBaseUrl().replace(/\/$/, '')}${path}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${getApiKey()}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    let text = '';
    try { text = await res.text(); } catch { /* */ }
    let parsed: Envelope<T> | null = null;
    try { parsed = text ? (JSON.parse(text) as Envelope<T>) : null; } catch { /* */ }
    if (!res.ok) {
      // v5.2.3 — l'upstream renvoie l'erreur sous plusieurs noms selon
      // l'endpoint (`error`, `message`, `details`, `error_description`).
      // Sans ça l'utilisateur voyait juste « HTTP 400 » sans aucune
      // explication de pourquoi.
      const obj = (parsed ?? {}) as Record<string, unknown>;
      const msg =
        (typeof obj.error === 'string' && obj.error) ||
        (typeof obj.message === 'string' && obj.message) ||
        (typeof (obj as { details?: unknown }).details === 'string' && (obj as { details: string }).details) ||
        (typeof (obj as { error_description?: unknown }).error_description === 'string' && (obj as { error_description: string }).error_description) ||
        `HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ''}`;
      throw new SmsUpstreamError(msg, res.status);
    }
    if (parsed && parsed.success === false) {
      throw new SmsUpstreamError(parsed.error || 'Upstream returned success=false', 502);
    }
    // L'envelope { success: true, data: T } est la convention 1001SMS.
    // Quand l'upstream renvoie directement T (pas d'envelope), on
    // tolère et renvoie tel quel.
    return (parsed?.data ?? (parsed as unknown as T) ?? ({} as T));
  } catch (err) {
    if (err instanceof SmsUpstreamError) throw err;
    if ((err as { name?: string }).name === 'AbortError') {
      throw new SmsUpstreamError(`Upstream timed out after ${TIMEOUT_MS}ms`, 504);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export const sms1001 = {
  configured: () => Boolean(getApiKey()),

  // Lookups
  services: () => request<SmsService[]>('GET', '/informative/services'),
  countries: () => request<SmsCountry[]>('GET', '/informative/countries'),
  pricing: (q: { country?: string; service?: string }) => {
    const params = new URLSearchParams();
    if (q.country) params.set('country', q.country);
    if (q.service) params.set('service', q.service);
    const qs = params.toString();
    return request<unknown>('GET', `/informative/pricing${qs ? `?${qs}` : ''}`);
  },
  balance: () => request<SmsBalance>('GET', '/informative/balance'),

  // Activations
  order: (body: { country: string; service: string; provider: string; purchaseType: string }) =>
    request<SmsOrder>('POST', '/activations/order', body),
  // v5.2.3 — send orderId under multiple field names so we're tolerant
  // of upstream variations (some endpoints expect order_id snake_case).
  // The upstream picks whichever field it knows ; the others are
  // ignored.
  check: (orderId: string) =>
    request<unknown>('POST', '/activations/check', { orderId, order_id: orderId, id: orderId }),
  details: (orderId: string) => request<unknown>('GET', `/activations/${encodeURIComponent(orderId)}`),
  active: (q: { page?: number; limit?: number }) => {
    const params = new URLSearchParams();
    if (q.page) params.set('page', String(q.page));
    if (q.limit) params.set('limit', String(q.limit));
    const qs = params.toString();
    return request<unknown>('GET', `/activations/active${qs ? `?${qs}` : ''}`);
  },
  history: (q: { page?: number; limit?: number; status?: string; from?: string; to?: string }) => {
    const params = new URLSearchParams();
    if (q.page) params.set('page', String(q.page));
    if (q.limit) params.set('limit', String(q.limit));
    if (q.status) params.set('status', q.status);
    if (q.from) params.set('from', q.from);
    if (q.to) params.set('to', q.to);
    const qs = params.toString();
    return request<unknown>('GET', `/activations/history${qs ? `?${qs}` : ''}`);
  },
  cancel: (orderId: string) =>
    request<unknown>('POST', '/activations/cancel', { orderId, order_id: orderId, id: orderId }),
  cancelAll: () => request<unknown>('POST', '/activations/cancel-all'),
  archiveAll: () => request<unknown>('GET', '/activations/archive-all'),
};
