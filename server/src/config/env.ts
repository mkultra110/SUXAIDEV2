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

export const corsOrigins =
  env.CORS_ORIGINS === '*'
    ? true
    : env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
