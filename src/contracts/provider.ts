// MemoryProvider interface — every provider (local, saas) must implement this.
// Input/output types are Zod-inferred from wire.ts.
import type { IngestPayload, RecallRequest, RecallResponse, HealthResponse } from './wire.ts';

export interface MemoryProvider {
  /**
   * Fire-and-forget ingest. Errors are logged but do not propagate to the caller.
   * Must complete or time out within 2 seconds.
   */
  ingest(payload: IngestPayload): Promise<void>;

  /**
   * Synchronous recall. Returns matched hits in unified RecallResponse shape.
   * Must complete within 5 seconds.
   */
  recall(req: RecallRequest): Promise<RecallResponse>;

  /**
   * Remember a new memory item. Similar to ingest but may return confirmation.
   */
  remember(req: IngestPayload): Promise<void>;

  /**
   * Health probe. Returns HealthResponse with ok=true if the provider is reachable.
   */
  health(): Promise<HealthResponse>;
}
