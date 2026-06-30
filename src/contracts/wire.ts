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
// Transcript ingest (ingest-transcript subcommand — FEAT 4a §4.1.1)
// ---------------------------------------------------------------------------

export const TranscriptTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string(),
  ts: z.string().optional(), // ISO-8601 if present
});

export type TranscriptTurn = z.infer<typeof TranscriptTurnSchema>;

// Aligned with SaaS canonical IngestTranscriptRequest at:
//   C:\work\mega\memory\src\AstraMemory.Api\Models\IngestTranscriptRequest.cs
// Plus Slice 3.5 additions (client_scrub_version, client_scrub_hits_by_label).
// `wire_version` field is pending — added when SaaS DTO catches up (FEAT 4a wire-contract slice).
export const TranscriptIngestPayloadSchema = z.object({
  event: z.enum(['pre_compact', 'session_end', 'subagent_stop']),
  session_id: z.string(),
  project_id: z.string(),
  agent_type: z.string().optional(),
  cwd: z.string().optional(),
  captured_at: z.string(), // ISO-8601
  turns: z.array(TranscriptTurnSchema),
  /** @deprecated use client_scrub_version + client_scrub_hits_by_label (v0.7.0 removal) */
  client_scrub_applied: z.boolean(),
  /** @deprecated use client_scrub_hits_by_label sum (v0.7.0 removal) */
  client_scrub_hits: z.number().int().nonnegative(),
  client_version: z.string(),
  /** Scrubber version constant — consumers can assert minimum version. */
  client_scrub_version: z.string(),
  /** Per-label hit counts from scrubWithLabels() across all turns. */
  client_scrub_hits_by_label: z.record(z.string(), z.number().int().nonnegative()).optional(),
});

export type TranscriptIngestPayload = z.infer<typeof TranscriptIngestPayloadSchema>;

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
