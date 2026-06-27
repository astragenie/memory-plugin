// AstramemConfig Zod schema — validates ~/.config/astramem/config.json
import { z } from 'zod';

const ProviderEndpointSchema = z.object({
  /** Base URL of the provider API. */
  url: z.string().url().optional(),
  /** Bearer token for authentication. */
  bearer: z.string().optional(),
});

export const AstramemConfigSchema = z.object({
  /**
   * Which provider to use: 'local' | 'saas' | 'auto'.
   * 'auto' probes local /health first; falls back to saas.
   */
  provider: z.enum(['local', 'saas', 'auto']).default('auto'),

  /** Local provider config (default: http://127.0.0.1:7777). */
  local: ProviderEndpointSchema.default({}),

  /** SaaS provider config. */
  saas: ProviderEndpointSchema.default({}),

  /** Logging configuration. */
  logging: z.object({
    level: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
  }).default({}),
});

export type AstramemConfig = z.infer<typeof AstramemConfigSchema>;
