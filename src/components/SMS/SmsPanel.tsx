/**
 * v5.2 — SMS panel modal.
 *
 * Lets the user buy a temporary phone number, poll for incoming SMS,
 * and manage active orders. All requests go through the SUXAI server
 * (which holds the 1001SMS API key) — the renderer never touches the
 * upstream key.
 *
 * Open via `openSmsPanel()` (Command Palette → « SMS: Phone numbers »
 * or via Ctrl+Shift+S).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../ui/Toast';
import { AtelierIcon } from '../ui/AtelierIcon';
import { smsApi, type SmsService, type SmsCountry } from '../../api/sms';
import './SmsPanel.css';

const SMS_OPEN_EVENT = 'suxai:open-sms';
const POLL_INTERVAL_MS = 8_000;

export function openSmsPanel(): void {
  window.dispatchEvent(new CustomEvent(SMS_OPEN_EVENT));
}

interface ActiveOrder {
  orderId: string;
  phone?: string;
  service?: string;
  country?: string;
  status?: string;
  createdAt?: string;
  messages?: Array<{ from?: string; text?: string; createdAt?: string }>;
}

export function SmsPanel() {
  const { token } = useAuth();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [services, setServices] = useState<SmsService[]>([]);
  const [countries, setCountries] = useState<SmsCountry[]>([]);
  const [country, setCountry] = useState('');
  const [service, setService] = useState('');
  const [provider, setProvider] = useState('any');
  const [purchaseType, setPurchaseType] = useState('activation');
  const [busy, setBusy] = useState(false);
  const [orders, setOrders] = useState<ActiveOrder[]>([]);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ---- Mount / open ---------------------------------------------------------

  useEffect(() => {
    const handler = () => setOpen(true);
    window.addEventListener(SMS_OPEN_EVENT, handler);
    return () => window.removeEventListener(SMS_OPEN_EVENT, handler);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // ---- Initial data load ----------------------------------------------------

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const cfg = await smsApi.configured(token);
      setConfigured(cfg.configured);
      if (!cfg.configured) return;
      const [svc, ctry, bal, act] = await Promise.allSettled([
        smsApi.services(token),
        smsApi.countries(token),
        smsApi.balance(token),
        smsApi.active(token),
      ]);
      if (svc.status === 'fulfilled') setServices(svc.value);
      if (ctry.status === 'fulfilled') setCountries(ctry.value);
      if (bal.status === 'fulfilled') {
        const b = bal.value;
        setBalance(
          typeof b?.balance === 'number'
            ? `${b.balance.toFixed(2)} ${b.currency ?? ''}`.trim()
            : '—',
        );
      }
      if (act.status === 'fulfilled') {
        const list = normaliseOrders(act.value);
        setOrders(list);
      }
    } catch (err) {
      toast.error('SMS panel', (err as Error).message);
    }
  }, [token, toast]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  // ---- Polling for new SMS on active orders ---------------------------------

  useEffect(() => {
    if (!open || !configured || orders.length === 0) {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
      return;
    }
    if (pollRef.current) return;
    pollRef.current = setInterval(async () => {
      if (!token) return;
      try {
        const updated = await Promise.all(
          orders.map(async (o) => {
            try {
              const detail = await smsApi.check(token, o.orderId);
              return mergeOrder(o, detail);
            } catch {
              return o;
            }
          }),
        );
        setOrders(updated);
      } catch { /* */ }
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [open, configured, orders, token]);

  // ---- Actions --------------------------------------------------------------

  const placeOrder = async () => {
    if (!token || busy) return;
    if (!country || !service) {
      toast.info('Select country and service first');
      return;
    }
    setBusy(true);
    try {
      const r = await smsApi.order(token, { country, service, provider, purchaseType });
      toast.success('Order placed', r.phone ?? r.orderId ?? 'Number reserved');
      await refresh();
    } catch (err) {
      toast.error('Order failed', (err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const cancelOrder = async (id: string) => {
    if (!token) return;
    try {
      await smsApi.cancel(token, id);
      toast.info('Order cancelled');
      await refresh();
    } catch (err) {
      toast.error('Cancel failed', (err as Error).message);
    }
  };

  const checkOrder = async (id: string) => {
    if (!token) return;
    try {
      const detail = await smsApi.check(token, id);
      setOrders((list) => list.map((o) => (o.orderId === id ? mergeOrder(o, detail) : o)));
    } catch (err) {
      toast.error('Check failed', (err as Error).message);
    }
  };

  // ---- Render ---------------------------------------------------------------

  if (!open) return null;

  return createPortal(
    <div className="smsp__overlay" role="dialog" aria-modal="true" onClick={() => setOpen(false)}>
      <div className="smsp glass-strong" onClick={(e) => e.stopPropagation()}>
        <header className="smsp__head">
          <span className="smsp__icon" aria-hidden>
            <AtelierIcon name="i-comment" size={16} />
          </span>
          <div className="smsp__head-text">
            <div className="smsp__title">SUXAVOIP — temporary phone numbers</div>
            <div className="smsp__sub">
              {configured === null ? '…' :
                configured ? `SUXAVOIP · balance ${balance ?? '—'}` :
                'API key not configured on the server'}
            </div>
          </div>
          <button
            type="button"
            className="smsp__refresh"
            onClick={() => void refresh()}
            title="Refresh"
            aria-label="Refresh"
          >
            ↻
          </button>
          <button
            type="button"
            className="smsp__close"
            onClick={() => setOpen(false)}
            title="Close (Esc)"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        {configured === false && (
          <div className="smsp__notice">
            <p>
              Le serveur n'a pas <code>SUXAVOIP_API_KEY</code> configuré.
              SSH sur le VPS, édite <code>/opt/suxai/.env</code> et ajoute :
            </p>
            <pre>SUXAVOIP_API_KEY=ta_clé</pre>
            <p>Puis <code>sudo systemctl restart suxai-server</code>.</p>
          </div>
        )}

        {configured === true && (
          <>
            <section className="smsp__section">
              <h3 className="smsp__section-title">New order</h3>
              <div className="smsp__form">
                <label>
                  <span>Country</span>
                  <select value={country} onChange={(e) => setCountry(e.target.value)}>
                    <option value="">— pick country —</option>
                    {countries.map((c) => (
                      <option key={c.code} value={c.code}>
                        {c.name ?? c.code} ({c.code})
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Service</span>
                  <select value={service} onChange={(e) => setService(e.target.value)}>
                    <option value="">— pick service —</option>
                    {services.map((s) => (
                      <option key={s.slug} value={s.slug}>
                        {s.name ?? s.slug}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>Provider</span>
                  <input
                    type="text"
                    value={provider}
                    onChange={(e) => setProvider(e.target.value)}
                    placeholder="any"
                  />
                </label>
                <label>
                  <span>Purchase type</span>
                  <input
                    type="text"
                    value={purchaseType}
                    onChange={(e) => setPurchaseType(e.target.value)}
                    placeholder="activation"
                  />
                </label>
              </div>
              <button
                type="button"
                className="smsp__order-btn"
                onClick={() => void placeOrder()}
                disabled={busy || !country || !service}
              >
                {busy ? 'Ordering…' : 'Order number'}
              </button>
            </section>

            <section className="smsp__section">
              <h3 className="smsp__section-title">
                Active orders ({orders.length})
              </h3>
              {orders.length === 0 ? (
                <div className="smsp__empty">No active orders.</div>
              ) : (
                <ul className="smsp__orders">
                  {orders.map((o) => (
                    <li key={o.orderId} className="smsp__order">
                      <div className="smsp__order-head">
                        <code className="smsp__phone">{o.phone ?? '(no number)'}</code>
                        <span className="smsp__order-meta">
                          {o.service ?? '?'} · {o.country ?? '?'} · {o.status ?? '?'}
                        </span>
                        <button
                          type="button"
                          className="smsp__order-action"
                          onClick={() => void checkOrder(o.orderId)}
                          title="Check now"
                        >
                          Check
                        </button>
                        <button
                          type="button"
                          className="smsp__order-action smsp__order-action--danger"
                          onClick={() => void cancelOrder(o.orderId)}
                          title="Cancel order"
                        >
                          Cancel
                        </button>
                      </div>
                      {(o.messages ?? []).length > 0 && (
                        <ul className="smsp__msgs">
                          {(o.messages ?? []).map((m, i) => (
                            <li key={i} className="smsp__msg">
                              <span className="smsp__msg-from">{m.from ?? '?'}</span>
                              <span className="smsp__msg-text">{m.text ?? ''}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}

        <footer className="smsp__foot">
          <kbd>Esc</kbd> close · numbers auto-refresh every {POLL_INTERVAL_MS / 1000}s
        </footer>
      </div>
    </div>,
    document.body,
  );
}

// ---- Helpers ----------------------------------------------------------------

function normaliseOrders(payload: unknown): ActiveOrder[] {
  // The 1001SMS API may wrap the list in { orders: [...] } or return
  // the array directly. We accept both.
  if (Array.isArray(payload)) return payload as ActiveOrder[];
  if (payload && typeof payload === 'object') {
    const obj = payload as { orders?: unknown; list?: unknown; data?: unknown };
    const candidate = obj.orders ?? obj.list ?? obj.data;
    if (Array.isArray(candidate)) return candidate as ActiveOrder[];
  }
  return [];
}

function mergeOrder(prev: ActiveOrder, detail: unknown): ActiveOrder {
  if (!detail || typeof detail !== 'object') return prev;
  const d = detail as Partial<ActiveOrder> & { sms?: ActiveOrder['messages'] };
  return {
    ...prev,
    status: d.status ?? prev.status,
    messages: d.messages ?? d.sms ?? prev.messages,
  };
}
