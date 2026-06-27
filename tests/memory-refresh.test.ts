import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

describe('memory-refresh', () => {
  it('prints cached token when expiry > 5 min away', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-test-'));
    const memoryDir = join(dir, 'memory');

    const env = { ...process.env };
    env['APPDATA'] = dir;
    env['XDG_CONFIG_HOME'] = dir;

    mkdirSync(memoryDir, { recursive: true });
    const authPath = join(memoryDir, 'auth.json');
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    writeFileSync(authPath, JSON.stringify({
      access_token: 'cached-token-abc',
      refresh_token: 'rt',
      expires_at: expiresAt,
      authority: 'https://acme.clerk.accounts.dev',
      client_id: 'cid',
    }));

    const result = spawnSync(
      'bun',
      [join(repoRoot, 'bin', 'memory-refresh.ts')],
      { env: env as NodeJS.ProcessEnv, encoding: 'utf8', cwd: repoRoot }
    );

    expect(result.status, `memory-refresh should exit 0 (stderr: ${result.stderr})`).toBe(0);
    expect(result.stdout).toBe('cached-token-abc');

    rmSync(dir, { recursive: true, force: true });
  });

  it('exits 2 when no auth.json present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-noauth-'));

    const env = { ...process.env };
    env['APPDATA'] = dir;
    env['XDG_CONFIG_HOME'] = dir;

    const result = spawnSync(
      'bun',
      [join(repoRoot, 'bin', 'memory-refresh.ts')],
      { env: env as NodeJS.ProcessEnv, encoding: 'utf8', cwd: repoRoot }
    );

    expect(result.status, `memory-refresh should exit 2 (stderr: ${result.stderr})`).toBe(2);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe('memory-token', () => {
  it('exits 2 when no auth.json present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memory-token-noauth-'));

    const env = { ...process.env };
    env['APPDATA'] = dir;
    env['XDG_CONFIG_HOME'] = dir;

    const result = spawnSync(
      'bun',
      [join(repoRoot, 'bin', 'memory-token.ts')],
      { env: env as NodeJS.ProcessEnv, encoding: 'utf8', cwd: repoRoot }
    );

    expect(result.status, `memory-token should exit 2 (stderr: ${result.stderr})`).toBe(2);

    rmSync(dir, { recursive: true, force: true });
  });
});
