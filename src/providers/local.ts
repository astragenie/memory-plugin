/**
 * Local AstraMemory provider.
 *
 * Implements MemoryProvider against the local daemon running at
 * http://127.0.0.1:7777 (or config.local.url / MEMORY_API_URL_LOCAL).
 *
 * Bearer is read from lib/secrets.ts (reads `<unifiedConfigDir()>/secrets.env`
 * populated by astramem-local). Track B owns the full secrets reader;
 * this provider imports from the canonical path.
 *
 * Timeouts:
 *   ingest  — 2 s (fire-and-forget; retries 1× on 5xx / network error)
 *   recall  — 5 s
 *   remember — 5 s
 *   health  — 3 s
 *
 * Error mapping:
 *   4xx → DeterministicError (do not retry)
 *   5xx / network → TransientError (retry once for ingest; throw for recall/remember/health)
 */

import type { MemoryProvider } from '../contracts/provider.ts';
import type {
  IngestPayload,
  RecallRequest,
  RecallResponse,
  HealthResponse,
} from '../contracts/wire.ts';
import { RecallResponseSchema, HealthResponseSchema } from '../contracts/wire.ts';
import { DeterministicError, TransientError } from '../lib/errors.ts';
import { readLocalBearer } from '../../lib/secrets.ts';

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

const DEFAULT_LOCAL_URL = 'http://127.0.0.1:7777';

function resolveBaseUrl(): string {
  return process.env['MEMORY_API_URL_LOCAL'] ?? DEFAULT_LOCAL_URL;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

/**
 * Fetch with an AbortController timeout. Throws TransientError on network
 * failures and timeout; throws DeterministicError on 4xx.
 */
async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal });
    return res;
  } catch (err: unknown) {
    if ((err as Error)?.name === 'AbortError') {
      throw new TransientError(`Request timed out after ${timeoutMs}ms`, undefined, err);
    }
    throw new TransientError(`Network error: ${(err as Error)?.message ?? String(err)}`, undefined, err);
  } finally {
    clearTimeout(timer);
  }
}

/** Build common headers (Authorization never logged — scrub applied upstream). */
async function buildHeaders(): Promise<Record<string, string>> {
  const bearer = await readLocalBearer();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (bearer) {
    headers['Authorization'] = `Bearer ${bearer}`;
  }
  return headers;
}

/**
 * Assert a response is OK.  4xx → DeterministicError; 5xx → TransientError.
 * Does NOT log the response body (may contain bearer echoes on some servers).
 */
async function assertOk(res: Response, context: string): Promise<void> {
  if (res.ok) return;
  const statusText = res.statusText || String(res.status);
  if (res.status >= 400 && res.status < 500) {
    throw new DeterministicError(
      `${context}: ${res.status} ${statusText}`,
      res.status,
    );
  }
  throw new TransientError(
    `${context}: ${res.status} ${statusText}`,
    res.status,
  );
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class LocalProvider implements MemoryProvider {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? resolveBaseUrl()).replace(/\/$/, '');
  }

  /**
   * Fire-and-forget ingest.  Retries once on TransientError within the 2s budget.
   * Never propagates errors — caller is insulated per the contract.
   */
  async ingest(payload: IngestPayload): Promise<void> {
    const attemptIngest = async (): Promise<void> => {
      const headers = await buildHeaders();
      const res = await fetchWithTimeout(
        `${this.baseUrl}/ingest/transcript`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(payload),
        },
        2000,
      );
      await assertOk(res, 'ingest');
    };

    try {
      await attemptIngest();
    } catch (err: unknown) {
      if (err instanceof TransientError) {
        // Retry once on transient failure.
        try {
          await attemptIngest();
        } catch {
          // Silently absorb — ingest is fire-and-forget.
        }
        return;
      }
      // DeterministicError also absorbed for fire-and-forget.
    }
  }

  async recall(req: RecallRequest): Promise<RecallResponse> {
    const headers = await buildHeaders();
    const res = await fetchWithTimeout(
      `${this.baseUrl}/recall`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(req),
      },
      5000,
    );
    await assertOk(res, 'recall');
    const json: unknown = await res.json();
    return RecallResponseSchema.parse(json);
  }

  async remember(req: IngestPayload): Promise<void> {
    const headers = await buildHeaders();
    const res = await fetchWithTimeout(
      `${this.baseUrl}/remember`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify(req),
      },
      5000,
    );
    await assertOk(res, 'remember');
  }

  async health(): Promise<HealthResponse> {
    const t0 = Date.now();
    const headers = await buildHeaders();
    const res = await fetchWithTimeout(
      `${this.baseUrl}/health`,
      { method: 'GET', headers },
      3000,
    );
    const latencyMs = Date.now() - t0;
    await assertOk(res, 'health');
    const json: unknown = await res.json();
    const parsed = HealthResponseSchema.parse(json);
    return { ...parsed, url: this.baseUrl, latencyMs };
  }
}

/** Factory — creates a LocalProvider with optional URL override from config. */
export function createLocalProvider(opts?: { url?: string }): LocalProvider {
  return new LocalProvider(opts?.url);
}
