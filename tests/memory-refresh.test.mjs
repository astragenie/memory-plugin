import { strict as assert } from 'node:assert';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..');

// Sets up a fake auth.json with expires_at = now + 1 hour, runs memory-refresh,
// asserts the script prints the cached access token unchanged (no network).
test('memory-refresh prints cached token when expiry > 5 min away', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-test-'));
  const memoryDir = join(dir, 'memory');

  // Force the helper to write into our temp dir by overriding APPDATA / XDG_CONFIG_HOME.
  // This ensures the Windows code path is exercised even on Linux CI runners by
  // mocking APPDATA explicitly.
  const env = { ...process.env };
  // Mock both: the test will use whichever branch os.platform() picks,
  // but APPDATA is always set so Windows-style paths are covered.
  env.APPDATA = dir;
  env.XDG_CONFIG_HOME = dir;

  // Pre-seed auth.json.
  mkdirSync(memoryDir, { recursive: true });
  const authPath = join(memoryDir, 'auth.json');
  const expiresAt = Math.floor(Date.now() / 1000) + 3600; // 1 hour from now
  writeFileSync(authPath, JSON.stringify({
    access_token: 'cached-token-abc',
    refresh_token: 'rt',
    expires_at: expiresAt,
    authority: 'https://acme.clerk.accounts.dev',
    client_id: 'cid',
  }));

  const result = spawnSync(
    process.execPath,
    [join(repoRoot, 'bin', 'memory-refresh')],
    { env, encoding: 'utf8', cwd: repoRoot }
  );

  assert.equal(result.status, 0, `memory-refresh should exit 0 when token is fresh (stderr: ${result.stderr})`);
  assert.equal(result.stdout, 'cached-token-abc', 'memory-refresh should emit cached access token unchanged');

  rmSync(dir, { recursive: true, force: true });
});

test('memory-refresh exits 2 when no auth.json present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-noauth-'));

  // Point both env vars at an empty dir so auth.json is missing.
  const env = { ...process.env };
  env.APPDATA = dir;
  env.XDG_CONFIG_HOME = dir;

  const result = spawnSync(
    process.execPath,
    [join(repoRoot, 'bin', 'memory-refresh')],
    { env, encoding: 'utf8', cwd: repoRoot }
  );

  assert.equal(result.status, 2, `memory-refresh should exit 2 when no auth.json (stderr: ${result.stderr})`);

  rmSync(dir, { recursive: true, force: true });
});

test('memory-token exits 2 when no auth.json present', () => {
  const dir = mkdtempSync(join(tmpdir(), 'memory-token-noauth-'));

  const env = { ...process.env };
  env.APPDATA = dir;
  env.XDG_CONFIG_HOME = dir;

  const result = spawnSync(
    process.execPath,
    [join(repoRoot, 'bin', 'memory-token')],
    { env, encoding: 'utf8', cwd: repoRoot }
  );

  // memory-token delegates to memory-refresh; expect same exit code
  assert.equal(result.status, 2, `memory-token should exit 2 when no auth.json (stderr: ${result.stderr})`);

  rmSync(dir, { recursive: true, force: true });
});
