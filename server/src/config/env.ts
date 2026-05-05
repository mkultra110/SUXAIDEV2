import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  CORS_ORIGINS: z.string().default('*'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 chars'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL: z.string().default('30d'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(8).max(15).default(12),

  DATA_DIR: z.string().default('./data'),

  QUATARLY_API_KEY: z.string().default(''),
  QUATARLY_BASE_URL: z.string().url().default('https://api.quatarly.cloud'),

  // v5.2.1 — SUXAVOIP integration (proxy au-dessus du provider SMS
  // upstream). Optional ; quand vide, /sms/* renvoie 503 et le panel
  // client affiche un message « configure SUXAVOIP_API_KEY dans
  // /opt/suxai/.env ». L'env var hérite (alias) de SMS1001_API_KEY si
  // SUXAVOIP_API_KEY n'est pas défini, pour qu'un VPS configuré avant
  // le rebrand n'ait pas besoin d'être édité.
  SUXAVOIP_API_KEY: z.string().default(''),
  SUXAVOIP_BASE_URL: z.string().url().default('https://www.1001sms.com/api/v1'),
  SMS1001_API_KEY: z.string().default(''),
  SMS1001_BASE_URL: z.string().url().default('https://www.1001sms.com/api/v1'),

  // Free tier cap — milliseconds of cumulative AI streaming time per
  // UTC day. Default 30 min.
  FREE_DAILY_LIMIT_MS: z.coerce.number().int().nonnegative().default(30 * 60 * 1000),

  UPDATE_VERSION: z.string().default('0.1.0'),
  UPDATE_URL: z.string().url().default('https://downloads.suxai.example/latest.exe'),
  UPDATE_NOTES: z.string().default(''),
  UPDATE_SHA256: z.string().default(''),
  UPDATE_SIZE: z.coerce.number().int().nonnegative().default(0),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  console.error('❌ Invalid environment configuration:');
  for (const issue of parsed.error.issues) {
    console.error(`  • ${issue.path.join('.')}: ${issue.message}`);
  }
  process.exit(1);
}

export const env = parsed.data;

// v0.15.10 (audit-4 #7) — never combine credentials:true with origin
// wildcard. In production we reject the wildcard outright (browsers
// block the combo anyway, but we catch misconfig at boot). In dev we
// keep `true` for localhost convenience but credentials:true on a
// non-public listener is acceptable because it's loopback only.
export const corsOrigins = (() => {
  if (env.CORS_ORIGINS === '*') {
    if (env.NODE_ENV === 'production') {
      throw new Error(
        'CORS_ORIGINS="*" is unsafe with credentials:true. Set an explicit ' +
          'comma-separated list of trusted origins in /opt/suxai/.env',
      );
    }
    return true;
  }
  return env.CORS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean);
})();
