/**
 * SaaS AstraMemory provider.
 *
 * Implements MemoryProvider against the SaaS gateway at MEMORY_API_URL_SAAS
 * (canonical deployment: https://api.astramemory.com).
 *
 * Endpoint map vs SaaS server (see C:\work\mega\memory\src\AstraMemory.Api\Controllers):
 *   - POST /ingest/transcript  → handled by TranscriptIngestController
 *   - POST /memories/search    → handled by MemoriesController (recall)
 *   - POST /memories           → handled by MemoriesController (remember)
 *   - GET  /health             → handled by HealthController
 *   - GET  /version            → handled by HealthController
 *
 * WIRE BUGS (FEAT 4a wire-contract unification — partially fixed):
 *   - recall() posts to /recall — SaaS has /memories/search
 *   - remember() posts to /remember — SaaS has /memories POST
 *   - ingestTranscript() added (Phase 3 Stage 1) — sends wire_version per FEAT 4a
 *
 * Bearer is read from lib/clerkAuthFile.ts (already exists — Wave 1 migrated).
 * URL from config.saas.url or env MEMORY_API_URL_SAAS.
 *
 * Timeouts:
 *   ingest   — 2 s (fire-and-forget; retries 1× on 5xx / network error)
 *   recall   — 5 s
 *   remember — 5 s
 *   health   — 3 s
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
  TranscriptIngestPayload,
} from '../contracts/wire.ts';
import { RecallResponseSchema, HealthResponseSchema, WIRE_VERSION } from '../contracts/wire.ts';
import { DeterministicError, TransientError } from '../lib/errors.ts';
import { readAuth } from '../../lib/clerkAuthFile.ts';
import { resolveEnv } from '../lib/env.ts';
import { ENV } from '../lib/env-specs.ts';
import { scrubWithLabels } from '../lib/scrub.ts';

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function resolveBaseUrl(): string {
  const res = resolveEnv(ENV.apiUrlSaas);
  if (res.value) return res.value.replace(/\/$/, '');
  throw new DeterministicError(
    'SaaS provider URL not configured. Set MEMORY_API_URL_SAAS env or config.saas.url.',
  );
}

// ---------------------------------------------------------------------------
// Fetch helpers (parallel to local.ts — no shared dependency per Track A scope)
// ---------------------------------------------------------------------------

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

/**
 * Read SaaS bearer.
 * Precedence: Clerk auth.json (OIDC) → MEMORY_BEARER env → ASTRAMEMORY_API_KEY env.
 * v0.7.0 will move OIDC refresh inside this function.
 */
async function readSaasBearer(): Promise<string | undefined> {
  const auth = await readAuth();
  if (auth?.access_token) return auth.access_token;
  // Static env fallback (see FEAT 4a §4.1.2 — OIDC refresh deferred to v0.7.0).
  return resolveEnv(ENV.bearerSaas).value;
}

async function buildHeaders(bearerOverride?: string): Promise<Record<string, string>> {
  const bearer = bearerOverride ?? (await readSaasBearer());
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (bearer) {
    // Bearer value never logged — scrub applied upstream by Track B.
    headers['Authorization'] = `Bearer ${bearer}`;
  }
  return headers;
}

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

export class SaasProvider implements MemoryProvider {
  private readonly baseUrl: string;

  constructor(baseUrl?: string) {
    this.baseUrl = (baseUrl ?? resolveBaseUrl()).replace(/\/$/, '');
  }

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
        try {
          await attemptIngest();
        } catch {
          // Silently absorb — ingest is fire-and-forget.
        }
        return;
      }
      // DeterministicError also absorbed for fire-and-forget ingest.
    }
  }

  /**
   * Fire-and-forget transcript ingest (FEAT 4a Phase 3 Stage 1).
   * Posts a TranscriptIngestPayload (which must include wire_version) to
   * /ingest/transcript. Retries once on TransientError. Never propagates —
   * caller is insulated per fire-and-forget contract.
   *
   * Defense-in-depth: applies a scrub pass on turn text before POSTing so that
   * programmatic callers (MCP, SDK) that bypass the CLI scrub layer are still
   * protected. CLI callers already scrubbed — scrubWithLabels is idempotent.
   *
   * NOTE: WIRE_VERSION is imported from contracts/wire.ts. Callers that build
   * the payload themselves (e.g. ingest-transcript CLI) already set
   * wire_version: WIRE_VERSION. The provider backfills defensively.
   */
  async ingestTranscript(payload: TranscriptIngestPayload): Promise<void> {
    // Defense-in-depth scrub: run scrubWithLabels on each turn's text before
    // sending to the wire. CLI callers already scrubbed (idempotent). Programmatic
    // callers (MCP, SDK) that skipped the CLI layer get scrub here.
    let totalHits = payload.client_scrub_hits;
    const mergedHitsByLabel: Record<string, number> = { ...(payload.client_scrub_hits_by_label ?? {}) };
    const scrubbedTurns = payload.turns.map((turn) => {
      const { output, hitsByLabel } = scrubWithLabels(turn.text);
      for (const [label, count] of Object.entries(hitsByLabel)) {
        mergedHitsByLabel[label] = (mergedHitsByLabel[label] ?? 0) + count;
        // Trust caller's prior counts; this layer ADDS scrubber output for any text the
        // caller missed. Sum may exceed actual redactions if caller mis-counted upstream.
        totalHits += count;
      }
      return { ...turn, text: output };
    });
    // Guarantee wire_version is present even if a caller forgot to set it
    // (defensive — schema validation at the CLI layer is the primary gate).
    const body: TranscriptIngestPayload = {
      ...payload,
      wire_version: payload.wire_version ?? WIRE_VERSION,
      turns: scrubbedTurns,
      client_scrub_applied: true,
      client_scrub_hits: totalHits,
      client_scrub_hits_by_label: mergedHitsByLabel,
    };
    const attemptIngestTranscript = async (): Promise<void> => {
      const headers = await buildHeaders();
      const res = await fetchWithTimeout(
        `${this.baseUrl}/ingest/transcript`,
        {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        },
        2000,
      );
      await assertOk(res, 'ingest/transcript');
    };

    try {
      await attemptIngestTranscript();
    } catch (err: unknown) {
      if (err instanceof TransientError) {
        try {
          await attemptIngestTranscript();
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

/**
 * Factory — creates a SaasProvider.
 * @param opts.url - explicit base URL (overrides env); must be set if MEMORY_API_URL_SAAS is absent.
 */
export function createSaasProvider(opts?: { url?: string }): SaasProvider {
  return new SaasProvider(opts?.url);
}
