// Provider selector types for the astramem CLI provider-selector.
import type { MemoryProvider } from './provider.ts';

/** Which backend to use. */
export type Provider = 'local' | 'saas';

/**
 * How the provider was resolved.
 * - 'flag'     — explicit --provider flag on the CLI
 * - 'env'      — ASTRAMEM_PROVIDER env var
 * - 'config'   — ~/.config/astramem/config.json
 * - 'auto'     — probed local /health; chose winner automatically
 * - 'fallback' — auto-probe timed out / failed; used saas as fallback
 */
export type SelectorSource = 'flag' | 'env' | 'config' | 'auto' | 'fallback';

/** Result returned by the selector after resolution. */
export interface SelectorResult {
  provider: MemoryProvider;
  /** Which provider was chosen. */
  providerName: Provider;
  /** How the provider was resolved. */
  source: SelectorSource;
  /** Latency of the /health probe used in 'auto' resolution (ms). */
  latency_probe_ms?: number;
}

/** Options passed to the selector. */
export interface SelectorOpts {
  /** Explicit provider override (from --provider flag). */
  flag?: Provider;
}
