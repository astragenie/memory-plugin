// Wire-level Zod schemas for the AstraMemory API.
// Shared between local and SaaS providers.
// Decisions 7-9 from memory-plugin#8: unified shape with required id/type/text/score;
// optional source/importance/confidence.
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

export const IngestPayloadSchema = z.object({
  /** Unique identifier for the session or item being ingested. */
  id: z.string().min(1),
  /** Content type: 'transcript' | 'note' | 'fact' | 'decision' | etc. */
  type: z.string().min(1),
  /** The text content to ingest. */
  text: z.string().min(1),
  /** Optional: originating source identifier (e.g. repo name, file path). */
  source: z.string().optional(),
  /** Optional: importance score 0..1. */
  importance: z.number().min(0).max(1).optional(),
  /** Optional: provider confidence 0..1. */
  confidence: z.number().min(0).max(1).optional(),
  /** Optional: additional key/value metadata. */
  metadata: z.record(z.unknown()).optional(),
});

export type IngestPayload = z.infer<typeof IngestPayloadSchema>;

// ---------------------------------------------------------------------------
// Recall
// ---------------------------------------------------------------------------

export const RecallRequestSchema = z.object({
  /** Natural-language query string. */
  query: z.string().min(1),
  /** Maximum number of results to return (default: 5). */
  k: z.number().int().min(1).max(100).default(5),
  /** Optional: filter by repo name. */
  repo: z.string().optional(),
  /** Optional: filter by project/workspace. */
  project: z.string().optional(),
});

export type RecallRequest = z.infer<typeof RecallRequestSchema>;

/** One memory hit in the recall response. */
export const RecallHitSchema = z.object({
  /** Unique ID of the memory item. */
  id: z.string(),
  /** Content type. */
  type: z.string(),
  /** The text of the memory. */
  text: z.string(),
  /** Relevance score 0..1 (higher = more relevant). */
  score: z.number().min(0).max(1),
  /** Optional originating source. */
  source: z.string().optional(),
  /** Optional importance weight. */
  importance: z.number().min(0).max(1).optional(),
  /** Optional provider confidence. */
  confidence: z.number().min(0).max(1).optional(),
});

export type RecallHit = z.infer<typeof RecallHitSchema>;

export const RecallResponseSchema = z.object({
  hits: z.array(RecallHitSchema),
  /** Total number of items searched. */
  total_searched: z.number().int().optional(),
  /** Provider that served the response. */
  provider: z.string().optional(),
});

export type RecallResponse = z.infer<typeof RecallResponseSchema>;

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  /** Provider version string. */
  version: z.string().optional(),
  /** The base URL that was probed. */
  url: z.string().optional(),
  /** Round-trip latency in milliseconds. */
  latencyMs: z.number().optional(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
