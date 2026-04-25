import { z } from 'zod';

const usernameField = z
  .string()
  .trim()
  .min(3, 'Username must be at least 3 characters')
  .max(24, 'Username is too long')
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    'Username can only contain letters, digits, underscore and dash',
  );

const passwordField = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password is too long');

export const loginSchema = z.object({
  username: usernameField,
  password: passwordField,
});

export type LoginInput = z.infer<typeof loginSchema>;

export const registerSchema = z.object({
  username: usernameField,
  password: passwordField,
});

export type RegisterInput = z.infer<typeof registerSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(10),
});

export type RefreshInput = z.infer<typeof refreshSchema>;

// SUXAI license format: SUXAI-XXXX-XXXX-XXXX where each block is
// uppercase alphanumerics matching the generator in store/licenses.ts.
// Strict validation here so a malformed input gets a helpful error
// instead of a silent "key not found".
export const redeemLicenseSchema = z.object({
  key: z
    .string()
    .trim()
    .toUpperCase()
    .regex(
      /^SUXAI-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/,
      'License keys look like SUXAI-XXXX-XXXX-XXXX (uppercase letters and digits).',
    ),
});

export type RedeemLicenseInput = z.infer<typeof redeemLicenseSchema>;
