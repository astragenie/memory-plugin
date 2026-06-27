#!/usr/bin/env bun
// memory-connect <ABCD-1234> [--env <env>] [--url <override>] [--workspace <name>]
//
// Redeems a claim code issued by the AstraMemory dashboard and stores the
// resulting ApiKey in ~/.astramemory/tokens.<env>.json keyed by workspaceId.
//
// Exit codes:
//   0  success
//   1  claim expired or invalid (HTTP 410)
//   2  network failure
//   3  filesystem write failure
//   4  profile not found (no matching entry in profiles.json)
import { basename } from 'node:path';
import { resolveProfile, writeToken } from '../lib/profileResolver.ts';

// ---------------------------------------------------------------------------
// Masking helper — never log an apiKey in full
// ---------------------------------------------------------------------------

/**
 * Mask all but the last 4 characters of a string.
 */
function maskKey(key: string): string {
  if (!key || key.length <= 4) return '****';
  return '*'.repeat(key.length - 4) + key.slice(-4);
}

// ---------------------------------------------------------------------------
// Structured observability — one JSON line per attempt to stderr
// ---------------------------------------------------------------------------

function emitLog(fields: Record<string, unknown>): void {
  process.stderr.write(JSON.stringify(fields) + '\n');
}

// ---------------------------------------------------------------------------
// Argument parsing (no new deps — pure manual parse)
// ---------------------------------------------------------------------------

interface ParsedArgs {
  code: string;
  env: string | null;
  url: string | null;
  workspace: string | null;
}

function parseArgs(argv: string[]): ParsedArgs {
  // argv[0] = node/bun, argv[1] = script, argv[2..] = user args
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(
      'Usage: memory-connect <ABCD-1234> [--env prod] [--url <override>] [--workspace <name>]\n' +
      '\n' +
      'Options:\n' +
      '  --env <env>         Target environment (default: $ASTRAMEMORY_ENV or "prod")\n' +
      '  --url <url>         Override API URL (skips profiles.json lookup)\n' +
      '  --workspace <name>  Workspace identifier (default: basename of cwd)\n' +
      '\n' +
      'Exit codes: 0=ok, 1=expired, 2=network, 3=fs, 4=profile missing\n'
    );
    process.exit(0);
  }

  const code = args[0]!;
  const result: ParsedArgs = { code, env: null, url: null, workspace: null };

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case '--env':
        result.env = args[++i] ?? null;
        break;
      case '--url':
        result.url = args[++i] ?? null;
        break;
      case '--workspace':
        result.workspace = args[++i] ?? null;
        break;
      default:
        process.stderr.write(`memory-connect: unknown argument '${args[i]}'\n`);
        process.exit(1);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface RedeemResponse {
  apiUrl?: string;
  tenantId?: string;
  workspaceId?: string | null;
  apiKey: string;
}

interface ProfileError extends Error {
  exitCode?: number;
}

async function main(): Promise<void> {
  const { code, env: envArg, url: urlArg, workspace: workspaceArg } = parseArgs(process.argv);

  const t0 = Date.now();

  // Resolve env: --env > $ASTRAMEMORY_ENV > "prod"
  const env = envArg ?? process.env['ASTRAMEMORY_ENV'] ?? 'prod';

  // Resolve workspaceId: --workspace > basename(cwd)
  const workspaceId = workspaceArg ?? basename(process.cwd());

  // Resolve API URL: --url > profiles.json[env].apiUrl > exit 4
  let apiUrl: string;
  if (urlArg) {
    apiUrl = urlArg;
  } else {
    // resolveProfile throws with .exitCode = 4 when profile missing
    const profile = await resolveProfile(env);
    apiUrl = profile.apiUrl;
  }

  // Strip trailing slash for clean URL construction
  const base = apiUrl.replace(/\/+$/, '');

  // POST /claims/<code>/redeem — expect 200 { apiUrl, tenantId, workspaceId, apiKey }
  let redeemData: RedeemResponse;
  try {
    const redeemResp = await fetch(`${base}/claims/${encodeURIComponent(code)}/redeem`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });

    if (redeemResp.status === 410) {
      emitLog({ service: 'memory', env, workspaceId, outcome: 'expired', durationMs: Date.now() - t0, exitCode: 1 });
      process.stderr.write('memory-connect: claim expired or invalid (HTTP 410)\n');
      process.exit(1);
    }

    if (!redeemResp.ok) {
      const body = await redeemResp.text().catch(() => '');
      emitLog({ service: 'memory', env, workspaceId, outcome: 'network', durationMs: Date.now() - t0, exitCode: 2 });
      process.stderr.write(`memory-connect: redeem failed: HTTP ${redeemResp.status} ${body}\n`);
      process.exit(2);
    }

    redeemData = await redeemResp.json() as RedeemResponse;
  } catch (err: unknown) {
    // Network / DNS failure (fetch threw before getting a response)
    emitLog({ service: 'memory', env, workspaceId, outcome: 'network', durationMs: Date.now() - t0, exitCode: 2 });
    process.stderr.write(`memory-connect: network error: ${(err as Error).message}\n`);
    process.exit(2);
  }

  const { apiKey, tenantId, workspaceId: resolvedWorkspaceId } = redeemData;
  // Use workspaceId returned by server if provided; fall back to local resolution
  const effectiveWorkspaceId = resolvedWorkspaceId ?? workspaceId;
  // Use apiUrl from redeem response if provided (canonical); fall back to resolved base
  const effectiveApiUrl = redeemData.apiUrl ?? base;

  // Persist token entry atomically
  const entry = {
    apiKey,
    label: `claim-${new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)}`,
    tenantId: tenantId ?? '',
    repoPath: process.cwd(),
    pairedAt: new Date().toISOString(),
  };

  try {
    await writeToken(env, effectiveWorkspaceId, entry);
  } catch (err: unknown) {
    emitLog({ service: 'memory', env, workspaceId: effectiveWorkspaceId, outcome: 'fs', durationMs: Date.now() - t0, exitCode: 3 });
    process.stderr.write(`memory-connect: failed to write token file: ${(err as Error).message}\n`);
    process.exit(3);
  }

  // Fire handshake envelope — soft-fail: do NOT exit non-zero on failure
  try {
    const handshakeResp = await fetch(`${effectiveApiUrl}/memories`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `ApiKey ${apiKey}`,
      },
      body: JSON.stringify({
        type: 'note',
        content: 'connect-handshake',
        source: 'memory-connect',
        tags: ['device-flow', 'handshake'],
        project_id: effectiveWorkspaceId,
      }),
    });
    if (!handshakeResp.ok) {
      process.stderr.write(
        `memory-connect: warning: handshake POST returned HTTP ${handshakeResp.status} — ` +
        `pairing succeeded but dashboard SSE may not flip immediately\n`
      );
    }
  } catch (err: unknown) {
    process.stderr.write(
      `memory-connect: warning: handshake POST failed (${(err as Error).message}) — ` +
      `pairing succeeded but dashboard SSE may not flip immediately\n`
    );
  }

  const durationMs = Date.now() - t0;
  emitLog({ service: 'memory', env, workspaceId: effectiveWorkspaceId, outcome: 'ok', durationMs, exitCode: 0 });

  // Success — never print the full apiKey
  const masked = maskKey(apiKey);
  process.stdout.write(
    `✓ Paired workspace "${effectiveWorkspaceId}" with env=${env} · ${masked}\n`
  );
}

const _mainStartedAt = Date.now();
main().catch((err: unknown) => {
  const e = err as ProfileError;
  // Propagate profile-resolution errors with the right exit code
  if (e.exitCode === 4) {
    emitLog({ service: 'memory', env: process.env['ASTRAMEMORY_ENV'] ?? 'prod', outcome: 'profile_missing', durationMs: Date.now() - _mainStartedAt, exitCode: 4 });
    process.stderr.write(`memory-connect: ${e.message}\n`);
    process.exit(4);
  }
  emitLog({ service: 'memory', env: process.env['ASTRAMEMORY_ENV'] ?? 'prod', outcome: 'error', durationMs: Date.now() - _mainStartedAt, exitCode: 2 });
  process.stderr.write(`memory-connect: unexpected error: ${e.message || e}\n`);
  process.exit(2);
});
