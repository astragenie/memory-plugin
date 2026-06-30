/**
 * E2E test helpers: ephemeral fake HTTP servers for local + saas provider testing.
 *
 * startFakeServer() spins up a node:http server on a random OS-assigned port.
 * Health and ingest/transcript routes are wired per the AstraMemory wire contract.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeServerOpts {
  /** Whether GET /health returns 200 ok:true (true) or 503 ok:false (false). */
  healthOk: boolean;
}

export interface FakeServerHandle {
  /** Base URL: http://127.0.0.1:<port> */
  url: string;
  /** Array of parsed JSON bodies posted to /ingest/transcript. */
  capturedBodies: unknown[];
  /** Shut the server down. */
  close(): Promise<void>;
  /** Count of requests received (health + ingest combined). */
  requestCount: number;
}

/** Collect the full body from an IncomingMessage as a string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/**
 * Start an ephemeral fake AstraMemory server on a random localhost port.
 *
 * Routes:
 *   GET  /health              → 200 {ok:true} or 503 {ok:false}
 *   POST /ingest/transcript   → captures body, returns 200 {ok:true, summary_memory_id:'fake-id'}
 *   *                         → 404
 */
export function startFakeServer(opts: FakeServerOpts): Promise<FakeServerHandle> {
  return new Promise((resolve, reject) => {
    const capturedBodies: unknown[] = [];
    let requestCount = 0;

    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      requestCount++;

      const method = req.method ?? 'GET';
      const url = req.url ?? '/';

      if (method === 'GET' && url === '/health') {
        const status = opts.healthOk ? 200 : 503;
        const body = JSON.stringify({ ok: opts.healthOk, version: '0.0.0-fake' });
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(body);
        return;
      }

      if (method === 'POST' && url === '/ingest/transcript') {
        readBody(req)
          .then((raw) => {
            let parsed: unknown;
            try {
              parsed = JSON.parse(raw);
            } catch {
              parsed = raw;
            }
            capturedBodies.push(parsed);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, summary_memory_id: 'fake-local-1' }));
          })
          .catch(() => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false }));
          });
        return;
      }

      // Catch-all 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    server.on('error', reject);

    // Bind to port 0 — OS assigns a free port.
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${addr.port}`;

      const handle: FakeServerHandle = {
        url,
        capturedBodies,
        get requestCount() {
          return requestCount;
        },
        close() {
          return new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          });
        },
      };

      resolve(handle);
    });
  });
}
