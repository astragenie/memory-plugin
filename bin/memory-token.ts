#!/usr/bin/env bun
// Convenience wrapper: prints a fresh access token to stdout for hook scripts.
// Equivalent to `memory-refresh` but returns exit 0 even when token is fresh.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const result = spawnSync('bun', [join(__dirname, 'memory-refresh.ts')], {
  stdio: ['inherit', 'pipe', 'inherit']
});
if (result.status !== 0) process.exit(result.status ?? 1);
if (result.stdout) process.stdout.write(result.stdout);
