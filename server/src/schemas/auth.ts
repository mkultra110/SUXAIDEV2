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

export const redeemLicenseSchema = z.object({
  key: z.string().trim().min(8).max(64),
});

export type RedeemLicenseInput = z.infer<typeof redeemLicenseSchema>;
