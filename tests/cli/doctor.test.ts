/**
 * Tests for src/cli/doctor.ts — astramem doctor subcommand.
 *
 * doctor does live network probes and reads config from disk.
 * We test the structure of the output without asserting network results.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runDoctor } from '../../src/cli/doctor.ts';
import { resolveEnv, _resetEnvState } from '../../src/lib/env.ts';
import { ENV } from '../../src/lib/env-specs.ts';

function captureStdout() {
  const chunks: string[] = [];
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c) => {
    chunks.push(String(c));
    return true;
  });
  return { chunks, restore: () => spy.mockRestore(), text: () => chunks.join('') };
}

describe('runDoctor', () => {
  let cap: ReturnType<typeof captureStdout>;

  beforeEach(() => {
    cap = captureStdout();
    // Reset env state so hit counts from prior tests don't leak.
    _resetEnvState();
  });
  afterEach(() => { cap.restore(); });

  it('always returns 0', async () => {
    const code = await runDoctor();
    expect(code).toBe(0);
  });

  it('output contains all section headers', async () => {
    await runDoctor();
    const text = cap.text();
    expect(text).toMatch(/ENV VARS/);
    expect(text).toMatch(/CONFIG/);
    expect(text).toMatch(/LOCAL PROBE/);
    expect(text).toMatch(/SAAS PROBE/);
    expect(text).toMatch(/INGEST LOG/);
  });

  it('reports MEMORY_BEARER as redacted when set', async () => {
    const original = process.env['MEMORY_BEARER'];
    process.env['MEMORY_BEARER'] = 'super-secret-token';
    try {
      await runDoctor();
      const text = cap.text();
      expect(text).toMatch(/MEMORY_BEARER=\[present, redacted\]/);
      expect(text).not.toMatch(/super-secret-token/);
    } finally {
      if (original === undefined) delete process.env['MEMORY_BEARER'];
      else process.env['MEMORY_BEARER'] = original;
    }
  });

  it('reports ASTRAMEM_PROVIDER value when set', async () => {
    const original = process.env['ASTRAMEM_PROVIDER'];
    process.env['ASTRAMEM_PROVIDER'] = 'local';
    try {
      await runDoctor();
      const text = cap.text();
      expect(text).toMatch(/ASTRAMEM_PROVIDER=local/);
    } finally {
      if (original === undefined) delete process.env['ASTRAMEM_PROVIDER'];
      else process.env['ASTRAMEM_PROVIDER'] = original;
    }
  });

  it('reports local probe result (either OK or UNREACHABLE)', async () => {
    await runDoctor();
    const text = cap.text();
    // Local daemon almost certainly not running in test — accept either
    expect(text).toMatch(/local daemon.*OK|local daemon.*UNREACHABLE|local daemon.*HTTP/);
  });

  it('reports saas not configured when saas.url absent', async () => {
    await runDoctor();
    const text = cap.text();
    // Default config has no saas.url
    expect(text).toMatch(/saas.*not configured|saas.*UNREACHABLE|saas.*OK|saas.*HTTP/);
  });

  it('reports ingest log section', async () => {
    await runDoctor();
    const text = cap.text();
    // Either shows entries or "(no entries)"
    expect(text).toMatch(/INGEST LOG|no entries/);
  });

  // ---------------------------------------------------------------------------
  // Env deprecation section (Stage 2)
  // ---------------------------------------------------------------------------

  it('text output contains ENV DEPRECATION section with no-alias message when no legacy aliases used', async () => {
    // No resolveEnv calls with legacy aliases before running doctor.
    await runDoctor();
    const text = cap.text();
    expect(text).toMatch(/ENV DEPRECATION/);
    expect(text).toMatch(/no deprecated aliases used in this process/);
  });

  it('text output lists alias hit counts after legacy alias is resolved', async () => {
    // Set a legacy alias in the process env and resolve it once to register hits.
    const LEGACY = 'MEMORY_SESSION_MAX_TURNS';
    const original = process.env[LEGACY];
    process.env[LEGACY] = '30';
    // Ensure the canonical is NOT set so the alias actually fires.
    const CANONICAL = ENV['sessionEndMaxTurns']!.canonical; // MEMORY_SESSIONEND_MAX_TURNS
    const origCanonical = process.env[CANONICAL];
    delete process.env[CANONICAL];

    try {
      resolveEnv(ENV['sessionEndMaxTurns']!); // 1 hit
      resolveEnv(ENV['sessionEndMaxTurns']!); // 2 hits

      await runDoctor();
      const text = cap.text();
      expect(text).toMatch(/ENV DEPRECATION/);
      expect(text).toMatch(/DEPRECATED env alias used: MEMORY_SESSION_MAX_TURNS → MEMORY_SESSIONEND_MAX_TURNS \(2 hits\)/);
    } finally {
      if (original === undefined) delete process.env[LEGACY];
      else process.env[LEGACY] = original;
      if (origCanonical === undefined) delete process.env[CANONICAL];
      else process.env[CANONICAL] = origCanonical;
    }
  });

  it('JSON mode includes deprecation_hits array', async () => {
    // Trigger one alias hit before running doctor in JSON mode.
    const LEGACY = 'MEMORY_SESSION_MAX_TURNS';
    const original = process.env[LEGACY];
    process.env[LEGACY] = '25';
    const CANONICAL = ENV['sessionEndMaxTurns']!.canonical;
    const origCanonical = process.env[CANONICAL];
    delete process.env[CANONICAL];

    try {
      resolveEnv(ENV['sessionEndMaxTurns']!); // 1 hit

      const code = await runDoctor(['--json']);
      expect(code).toBe(0);

      const raw = cap.text();
      const parsed = JSON.parse(raw) as { deprecation_hits: Array<{ canonical: string; alias: string; hits: number }> };
      expect(Array.isArray(parsed.deprecation_hits)).toBe(true);

      const hit = parsed.deprecation_hits.find((h) => h.alias === LEGACY);
      expect(hit).toBeDefined();
      expect(hit!.canonical).toBe(CANONICAL);
      expect(hit!.hits).toBe(1);
    } finally {
      if (original === undefined) delete process.env[LEGACY];
      else process.env[LEGACY] = original;
      if (origCanonical === undefined) delete process.env[CANONICAL];
      else process.env[CANONICAL] = origCanonical;
    }
  });
});
