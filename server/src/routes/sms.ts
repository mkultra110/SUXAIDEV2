/**
 * v5.2 — /sms/* — proxy pour 1001SMS.
 *
 * Toutes les routes nécessitent un JWT (requireAuth) puis forward
 * vers l'upstream via le service. La clé 1001SMS reste sur le VPS
 * — le client ne la voit jamais.
 *
 * Conventions :
 *   - GET pour les lookups + lectures (services, countries, pricing,
 *     balance, active, history, archive-all, details)
 *   - POST pour les actions qui débitent ou modifient (order, check,
 *     cancel, cancel-all)
 *
 * Toutes les réponses sont uniformisées en `{ ok, data }` ou
 * `{ ok: false, error, status }` pour que le client n'ait qu'un seul
 * format à parser.
 */
import { Router } from 'express';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import { requireAuth } from '../middleware/auth.js';
import { validateBody } from '../middleware/validate.js';
import { sms1001, SmsUpstreamError } from '../services/sms1001.service.js';

const router = Router();

// Rate limit modeste : ces endpoints touchent un upstream payant, on
// veut éviter qu'un user buggy envoie 1000 /order par minute.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

router.use(requireAuth);
router.use(limiter);

function ok(data: unknown) { return { ok: true, data }; }
function fail(err: unknown) {
  if (err instanceof SmsUpstreamError) {
    return {
      status: err.status,
      body: { ok: false, error: err.message, code: err.code ?? null, status: err.status },
    };
  }
  return {
    status: 502,
    body: { ok: false, error: (err as Error).message ?? 'Upstream error', status: 502 },
  };
}

// ---- Lookups ----------------------------------------------------------------

router.get('/configured', (_req, res) => {
  res.json({ ok: true, data: { configured: sms1001.configured() } });
});

router.get('/services', async (_req, res) => {
  try { res.json(ok(await sms1001.services())); }
  catch (err) { const f = fail(err); res.status(f.status).json(f.body); }
});

router.get('/countries', async (_req, res) => {
  try { res.json(ok(await sms1001.countries())); }
  catch (err) { const f = fail(err); res.status(f.status).json(f.body); }
});

router.get('/pricing', async (req, res) => {
  const country = typeof req.query.country === 'string' ? req.query.country : undefined;
  const service = typeof req.query.service === 'string' ? req.query.service : undefined;
  try { res.json(ok(await sms1001.pricing({ country, service }))); }
  catch (err) { const f = fail(err); res.status(f.status).json(f.body); }
});

router.get('/balance', async (_req, res) => {
  try { res.json(ok(await sms1001.balance())); }
  catch (err) { const f = fail(err); res.status(f.status).json(f.body); }
});

// ---- Activations ------------------------------------------------------------

const orderSchema = z.object({
  country: z.string().min(1).max(64),
  service: z.string().min(1).max(64),
  provider: z.string().min(1).max(64),
  purchaseType: z.string().min(1).max(64),
});

router.post('/order', validateBody(orderSchema), async (req, res) => {
  try { res.json(ok(await sms1001.order(req.body))); }
  catch (err) { const f = fail(err); res.status(f.status).json(f.body); }
});

const checkSchema = z.object({ orderId: z.string().min(1).max(128) });
router.post('/check', validateBody(checkSchema), async (req, res) => {
  try { res.json(ok(await sms1001.check(req.body.orderId))); }
  catch (err) { const f = fail(err); res.status(f.status).json(f.body); }
});

const cancelSchema = z.object({ orderId: z.string().min(1).max(128) });
router.post('/cancel', validateBody(cancelSchema), async (req, res) => {
  try { res.json(ok(await sms1001.cancel(req.body.orderId))); }
  catch (err) { const f = fail(err); res.status(f.status).json(f.body); }
});

router.post('/cancel-all', async (_req, res) => {
  try { res.json(ok(await sms1001.cancelAll())); }
  catch (err) { const f = fail(err); res.status(f.status).json(f.body); }
});

router.get('/active', async (req, res) => {
  const page = req.query.page ? Number(req.query.page) : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  try { res.json(ok(await sms1001.active({ page, limit }))); }
  catch (err) { const f = fail(err); res.status(f.status).json(f.body); }
});

router.get('/history', async (req, res) => {
  const page = req.query.page ? Number(req.query.page) : undefined;
  const limit = req.query.limit ? Number(req.query.limit) : undefined;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const from = typeof req.query.from === 'string' ? req.query.from : undefined;
  const to = typeof req.query.to === 'string' ? req.query.to : undefined;
  try { res.json(ok(await sms1001.history({ page, limit, status, from, to }))); }
  catch (err) { const f = fail(err); res.status(f.status).json(f.body); }
});

router.get('/archive-all', async (_req, res) => {
  try { res.json(ok(await sms1001.archiveAll())); }
  catch (err) { const f = fail(err); res.status(f.status).json(f.body); }
});

router.get('/order/:id', async (req, res) => {
  try { res.json(ok(await sms1001.details(req.params.id))); }
  catch (err) { const f = fail(err); res.status(f.status).json(f.body); }
});

export default router;
