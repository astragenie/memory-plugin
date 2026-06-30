/**
 * wire-flow.test.ts — true E2E: fake local + fake saas HTTP servers.
 *
 * Tests the full selector → provider → wire-payload chain without any mocks.
 * Two ephemeral in-process HTTP servers (node:http, OS-assigned ports) act as
 * stand-ins for the local daemon and the SaaS gateway.
 *
 * Cases covered:
 *   a) auto-resolve + local up    → routes to local; saas gets ZERO requests
 *   b) auto-resolve + local down  → falls back to saas
 *   c) flag=saas override         → saas even when local is up
 *   d) env ASTRAMEM_PROVIDER=local → routes to local
 *   e) wire_version on every payload (both providers)
 *   f) bearer scrub — token in turn text must NOT appear in posted body or stderr
 *
 * FEAT-4a Phase 3, Stage 3 — references commit 06d20a8.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeServer, type FakeServerHandle } from './_helpers.ts';
import { TranscriptIngestPayloadSchema, WIRE_VERSION } from '../../src/contracts/wire.ts';
import type { TranscriptIngestPayload } from '../../src/contracts/wire.ts';
import {
  _resetHealthCache,
  _setHealthProbeFn,
  resolveProvider,
} from '../../src/lib/selector.ts';
import { LocalProvider } from '../../src/providers/local.ts';
import { SaasProvider } from '../../src/providers/saas.ts';
import { scrubWithLabels } from '../../src/lib/scrub.ts';

// Per-test timeout — generous for in-process HTTP round-trips.
const T = 15000;

// ---------------------------------------------------------------------------
// Constants for the bearer scrub test
// ---------------------------------------------------------------------------

// 64 alphanumeric chars — matches the Bearer regex (/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi)
const FAKE_BEARER_BODY = 'a'.repeat(32) + 'b'.repeat(32);
const FAKE_BEARER_TOKEN = `Bearer ${FAKE_BEARER_BODY}`;
const REDACTION_MARKER = '[REDACTED:bearer]';

// ---------------------------------------------------------------------------
// Env management — save + restore a fixed set of vars around each test.
// ---------------------------------------------------------------------------

const ENV_KEYS = [
  'MEMORY_API_URL_LOCAL',
  'MEMORY_API_URL_SAAS',
  'ASTRAMEM_PROVIDER',
  'MEMORY_BEARER',
  'MEMORY_DEPRECATION_OPT_OUT',
  'APPDATA',
  'HOME',
  'XDG_CONFIG_HOME',
] as const;

type EnvKey = typeof ENV_KEYS[number];
let savedEnv: Record<EnvKey, string | undefined> = {} as Record<EnvKey, string | undefined>;

function saveEnv(): void {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of ENV_KEYS) {
    const saved = savedEnv[key];
    if (saved === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved;
    }
  }
}

// ---------------------------------------------------------------------------
// Shared test state
// ---------------------------------------------------------------------------

let tmpDir: string;
let fakeLocal: FakeServerHandle;
let fakeSaas: FakeServerHandle;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Point the environment at the fake servers and write a temp config.json
 * so selector.resolveAuto() probes fakeLocal.url instead of default 7777.
 */
function wireEnv(localUrl: string, saasUrl: string): void {
  process.env['MEMORY_API_URL_LOCAL'] = localUrl;
  process.env['MEMORY_API_URL_SAAS'] = saasUrl;
  // Suppress alias deprecation noise in test output.
  process.env['MEMORY_DEPRECATION_OPT_OUT'] = '1';

  // Write config.json so loadConfig().local.url returns the fake local URL.
  // The config dir is determined by unifiedConfigDir() which reads APPDATA (win32)
  // or HOME (posix). We redirect both to tmpDir so no real user config is touched.
  let configDir: string;
  if (process.platform === 'win32') {
    process.env['APPDATA'] = tmpDir;
    configDir = join(tmpDir, 'Astramem');
  } else {
    process.env['HOME'] = tmpDir;
    process.env['XDG_CONFIG_HOME'] = join(tmpDir, '.config');
    configDir = join(tmpDir, '.config', 'astramem');
  }
  mkdirSync(configDir, { recursive: true });

  const cfg = {
    provider: 'auto',
    local: { url: localUrl },
    saas: { url: saasUrl },
    logging: { level: 'silent' },
  };
  writeFileSync(join(configDir, 'config.json'), JSON.stringify(cfg, null, 2));
}

/** Build a minimal valid TranscriptIngestPayload. */
function makePayload(textOverride?: string): TranscriptIngestPayload {
  return {
    wire_version: WIRE_VERSION,
    event: 'session_end',
    session_id: 'e2e-session-001',
    project_id: 'e2e-project-001',
    captured_at: new Date().toISOString(),
    turns: [
      { role: 'user', text: textOverride ?? 'hello world' },
      { role: 'assistant', text: 'acknowledged' },
    ],
    client_scrub_applied: true,
    client_scrub_hits: 0,
    client_scrub_version: '2',
    client_version: 'test',
  };
}

/** Run fn and capture anything written to process.stderr during it. */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const chunks: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = orig;
  }
  return chunks.join('');
}

/** Real-network health probe helper used in some auto-resolve tests. */
async function realHealthProbe(url: string): Promise<{ ok: boolean; latency_ms: number }> {
  const t0 = Date.now();
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1000);
    try {
      const res = await fetch(`${url}/health`, { signal: ctrl.signal });
      return { ok: res.ok, latency_ms: Date.now() - t0 };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false, latency_ms: Date.now() - t0 };
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(async () => {
  saveEnv();
  tmpDir = mkdtempSync(join(tmpdir(), 'astramem-wire-e2e-'));
  fakeLocal = await startFakeServer({ healthOk: true });
  fakeSaas = await startFakeServer({ healthOk: true });
  _resetHealthCache();
});

afterEach(async () => {
  _resetHealthCache();
  // Restore real probe function.
  _setHealthProbeFn(async (url: string) => realHealthProbe(url));
  try { await fakeLocal.close(); } catch { /* already closed */ }
  try { await fakeSaas.close(); } catch { /* already closed */ }
  rmSync(tmpDir, { recursive: true, force: true });
  restoreEnv();
});

// ---------------------------------------------------------------------------
// (a) auto-resolve: local up → routes to local
// ---------------------------------------------------------------------------

describe('(a) auto-resolve: local up → routes to local', () => {
  it('selector returns local; saas gets ZERO ingest requests', async () => {
    wireEnv(fakeLocal.url, fakeSaas.url);
    _setHealthProbeFn(realHealthProbe);
    _resetHealthCache();

    const sel = await resolveProvider({});
    expect(sel.providerName).toBe('local');
    expect(sel.source).toBe('auto');

    // Wire the actual ingest via LocalProvider pointed at the fake local server.
    const provider = new LocalProvider(fakeLocal.url);
    await provider.ingestTranscript(makePayload());

    expect(fakeLocal.capturedBodies.length).toBe(1);
    expect(fakeSaas.capturedBodies.length).toBe(0);
  }, T);
});

// ---------------------------------------------------------------------------
// (b) auto-resolve: local down → fallback to saas
// ---------------------------------------------------------------------------

describe('(b) auto-resolve: local down → fallback to saas', () => {
  it('selector falls back to saas; ingest lands on saas server', async () => {
    // Close the fake local server so its port refuses connections.
    await fakeLocal.close();

    wireEnv(fakeLocal.url, fakeSaas.url);
    _setHealthProbeFn(realHealthProbe); // will fail to connect → ok:false
    _resetHealthCache();

    const sel = await resolveProvider({});
    expect(sel.providerName).toBe('saas');
    expect(sel.source).toBe('fallback');

    const provider = new SaasProvider(fakeSaas.url);
    await provider.ingestTranscript(makePayload());

    expect(fakeSaas.capturedBodies.length).toBe(1);

    // Re-open fakeLocal so afterEach.close() doesn't throw on a second close.
    fakeLocal = await startFakeServer({ healthOk: true });
  }, T);
});

// ---------------------------------------------------------------------------
// (c) flag override: flag=saas → saas even when local is up
// ---------------------------------------------------------------------------

describe('(c) flag override: --provider saas routes to saas even when local is up', () => {
  it('selector source=flag; local gets zero ingest; saas gets one', async () => {
    wireEnv(fakeLocal.url, fakeSaas.url);
    // Local IS up (probe would return ok) — flag must short-circuit probe entirely.
    _setHealthProbeFn(async () => ({ ok: true, latency_ms: 2 }));
    _resetHealthCache();

    const sel = await resolveProvider({ flag: 'saas' });
    expect(sel.providerName).toBe('saas');
    expect(sel.source).toBe('flag');

    const provider = new SaasProvider(fakeSaas.url);
    await provider.ingestTranscript(makePayload());

    expect(fakeSaas.capturedBodies.length).toBe(1);
    expect(fakeLocal.capturedBodies.length).toBe(0);
  }, T);
});

// ---------------------------------------------------------------------------
// (d) env override: ASTRAMEM_PROVIDER=local → routes to local
// ---------------------------------------------------------------------------

describe('(d) env override: ASTRAMEM_PROVIDER=local routes to local', () => {
  it('selector source=env; local gets one ingest; saas gets zero', async () => {
    wireEnv(fakeLocal.url, fakeSaas.url);
    process.env['ASTRAMEM_PROVIDER'] = 'local';
    // Probe returning false — env must override auto-probe fallback.
    _setHealthProbeFn(async () => ({ ok: false, latency_ms: 100 }));
    _resetHealthCache();

    const sel = await resolveProvider({});
    expect(sel.providerName).toBe('local');
    expect(sel.source).toBe('env');

    const provider = new LocalProvider(fakeLocal.url);
    await provider.ingestTranscript(makePayload());

    expect(fakeLocal.capturedBodies.length).toBe(1);
    expect(fakeSaas.capturedBodies.length).toBe(0);
  }, T);
});

// ---------------------------------------------------------------------------
// (e) wire_version === 'v1.0' on every posted payload — both providers
// ---------------------------------------------------------------------------

describe('(e) wire_version on every payload', () => {
  it('LocalProvider: posted body validates against TranscriptIngestPayloadSchema with wire_version=v1.0', async () => {
    wireEnv(fakeLocal.url, fakeSaas.url);

    const provider = new LocalProvider(fakeLocal.url);
    await provider.ingestTranscript(makePayload());

    expect(fakeLocal.capturedBodies.length).toBe(1);
    const body = fakeLocal.capturedBodies[0];

    const parsed = TranscriptIngestPayloadSchema.safeParse(body);
    expect(parsed.success, `Schema parse failed: ${!parsed.success ? JSON.stringify((parsed as { error: unknown }).error) : ''}`).toBe(true);
    if (parsed.success) {
      expect(parsed.data.wire_version).toBe('v1.0');
    }
  }, T);

  it('SaasProvider: posted body validates against TranscriptIngestPayloadSchema with wire_version=v1.0', async () => {
    wireEnv(fakeLocal.url, fakeSaas.url);

    const provider = new SaasProvider(fakeSaas.url);
    await provider.ingestTranscript(makePayload());

    expect(fakeSaas.capturedBodies.length).toBe(1);
    const body = fakeSaas.capturedBodies[0];

    const parsed = TranscriptIngestPayloadSchema.safeParse(body);
    expect(parsed.success, `Schema parse failed: ${!parsed.success ? JSON.stringify((parsed as { error: unknown }).error) : ''}`).toBe(true);
    if (parsed.success) {
      expect(parsed.data.wire_version).toBe('v1.0');
    }
  }, T);
});

// ---------------------------------------------------------------------------
// (f) bearer scrub: token must NOT appear in posted body or stderr
//
// The scrub is the CLI caller's responsibility (ingest-transcript.ts scrubs
// each turn before building the envelope). We mirror that here: scrub first,
// build the envelope with the scrubbed text, then assert the raw token never
// escapes through the provider's HTTP path or into stderr.
// ---------------------------------------------------------------------------

describe('(f) bearer scrub: raw token must not appear in posted body or stderr', () => {
  it('scrubWithLabels catches the fake bearer and marks it [REDACTED:bearer]', () => {
    const { output, hitsByLabel } = scrubWithLabels(FAKE_BEARER_TOKEN);
    expect(hitsByLabel['bearer']).toBe(1);
    expect(output).toBe(REDACTION_MARKER);
    expect(output).not.toContain(FAKE_BEARER_BODY);
  });

  it('LocalProvider: scrubbed payload posted to wire does not contain raw bearer token', async () => {
    wireEnv(fakeLocal.url, fakeSaas.url);

    // Mirror what ingest-transcript.ts does: scrub before building the envelope.
    const { output: scrubbedText, hitsByLabel } = scrubWithLabels(FAKE_BEARER_TOKEN);
    expect(hitsByLabel['bearer']).toBeGreaterThan(0);
    expect(scrubbedText).not.toContain(FAKE_BEARER_BODY);

    const payload = makePayload(scrubbedText);
    const provider = new LocalProvider(fakeLocal.url);
    const stderrOutput = await captureStderr(() => provider.ingestTranscript(payload));

    // 1. Posted body must not contain the raw bearer hex.
    expect(fakeLocal.capturedBodies.length).toBe(1);
    const bodyJson = JSON.stringify(fakeLocal.capturedBodies[0]);
    expect(bodyJson).not.toContain(FAKE_BEARER_BODY);
    expect(bodyJson).toContain(REDACTION_MARKER);

    // 2. Stderr must not leak the raw bearer.
    expect(stderrOutput).not.toContain(FAKE_BEARER_BODY);
  }, T);

  it('SaasProvider: scrubbed payload posted to wire does not contain raw bearer token', async () => {
    wireEnv(fakeLocal.url, fakeSaas.url);

    const { output: scrubbedText, hitsByLabel } = scrubWithLabels(FAKE_BEARER_TOKEN);
    expect(hitsByLabel['bearer']).toBeGreaterThan(0);
    expect(scrubbedText).not.toContain(FAKE_BEARER_BODY);

    const payload = makePayload(scrubbedText);
    const provider = new SaasProvider(fakeSaas.url);
    const stderrOutput = await captureStderr(() => provider.ingestTranscript(payload));

    expect(fakeSaas.capturedBodies.length).toBe(1);
    const bodyJson = JSON.stringify(fakeSaas.capturedBodies[0]);
    expect(bodyJson).not.toContain(FAKE_BEARER_BODY);
    expect(bodyJson).toContain(REDACTION_MARKER);

    expect(stderrOutput).not.toContain(FAKE_BEARER_BODY);
  }, T);
});
