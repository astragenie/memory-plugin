// astramem doctor — diagnose selector resolution, logs, env vars, and config.
// Walks: env vars, config presence + validation, local probe, saas probe, last 5 ingest log lines,
//        env-deprecation hit counts (alias reads accumulated in this process before doctor ran).
// Always exits 0. Prints a human-readable diagnostic table, or JSON with --json.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { unifiedConfigDir } from '../lib/datadir.ts';
import { loadConfig } from '../lib/config.ts';
import { readIngestLogTail } from '../lib/log.ts';
import { getDeprecationHits } from '../lib/env.ts';
import { ENV } from '../lib/env-specs.ts';
import { resolveLocalUrlWithSource } from '../lib/local-url.ts';
import { stats as pendingStats } from '../lib/pending.ts';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

export interface DeprecationHit {
  canonical: string;
  alias: string;
  hits: number;
}

/**
 * Build deprecation hit list from the per-process snapshot.
 * Maps alias → canonical by scanning all ENV specs.
 * Returns entries sorted by hits descending.
 * Does NOT call resolveEnv — avoids inflating the counters during doctor itself.
 */
function buildDeprecationHits(): DeprecationHit[] {
  const raw = getDeprecationHits(); // Record<alias, count>
  // Build alias → canonical reverse map from ENV registry
  const aliasToCanonical = new Map<string, string>();
  for (const spec of Object.values(ENV)) {
    for (const alias of spec.aliases ?? []) {
      // First canonical wins if alias appears in multiple specs (e.g. ASTRAMEMORY_API_KEY)
      if (!aliasToCanonical.has(alias)) {
        aliasToCanonical.set(alias, spec.canonical);
      }
    }
  }

  const hits: DeprecationHit[] = [];
  for (const [alias, count] of Object.entries(raw)) {
    if (count > 0) {
      hits.push({
        canonical: aliasToCanonical.get(alias) ?? '(unknown)',
        alias,
        hits: count,
      });
    }
  }
  // Sort hits descending
  hits.sort((a, b) => b.hits - a.hits);
  return hits;
}

/** Run the `astramem doctor` subcommand. Always returns 0. */
export async function runDoctor(args: string[] = []): Promise<number> {
  const jsonMode = args.includes('--json');
  const lines: string[] = [];
  const configDir = unifiedConfigDir();

  // Header
  lines.push('astramem doctor — diagnostics report');
  lines.push('─'.repeat(60));

  // 1. Environment variables
  lines.push('');
  lines.push('ENV VARS');
  const envVars = ['MEMORY_BEARER', 'MEMORY_API_URL', 'ASTRAMEM_PROVIDER'] as const;
  for (const v of envVars) {
    const val = process.env[v];
    if (val) {
      // Scrub bearer-looking values
      const display = v === 'MEMORY_BEARER' ? '[present, redacted]' : val;
      lines.push(`  ${v}=${display}`);
    } else {
      lines.push(`  ${v}=(not set)`);
    }
  }

  // 2. Config file presence + validation
  lines.push('');
  lines.push('CONFIG');
  const cfgPath = join(configDir, 'config.json');
  if (existsSync(cfgPath)) {
    lines.push(`  config.json: ${cfgPath} [present]`);
    try {
      const cfg = loadConfig();
      lines.push(`  provider: ${cfg.provider}`);
      lines.push(`  local.url: ${cfg.local.url ?? '(default: http://127.0.0.1:7777)'}`);
      lines.push(`  saas.url: ${cfg.saas.url ?? '(not configured)'}`);
      lines.push(`  logging.level: ${cfg.logging.level}`);
    } catch (e) {
      lines.push(`  config.json: INVALID — ${(e as Error).message}`);
    }
  } else {
    lines.push(`  config.json: (not found at ${cfgPath})`);
    lines.push('  Using defaults: provider=auto, local.url=http://127.0.0.1:7777');
  }

  // 3. Local daemon probe (Finding 5 fix: env-first URL via resolveLocalUrlWithSource)
  lines.push('');
  lines.push('LOCAL PROBE');
  const localUrlResolution = resolveLocalUrlWithSource();
  const localUrl = localUrlResolution.url;
  try {
    const start = Date.now();
    const resp = await Promise.race([
      fetch(`${localUrl}/health`),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
    ]);
    const latency = Date.now() - start;
    if (resp.ok) {
      lines.push(`  local daemon @ ${localUrl} [source: ${localUrlResolution.source}]: OK (${latency}ms)`);
    } else {
      lines.push(`  local daemon @ ${localUrl} [source: ${localUrlResolution.source}]: HTTP ${resp.status} (${latency}ms)`);
    }
  } catch (e) {
    lines.push(`  local daemon @ ${localUrl} [source: ${localUrlResolution.source}]: UNREACHABLE — ${(e as Error).message}`);
  }

  // 4. SaaS probe
  lines.push('');
  lines.push('SAAS PROBE');
  try {
    const cfg = loadConfig();
    const saasUrl = cfg.saas.url;
    if (!saasUrl) {
      lines.push('  saas: (not configured — set config.saas.url)');
    } else {
      const start = Date.now();
      const resp = await Promise.race([
        fetch(`${saasUrl}/health`),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), 3000)),
      ]);
      const latency = Date.now() - start;
      if (resp.ok) {
        lines.push(`  saas @ ${saasUrl}: OK (${latency}ms)`);
      } else {
        lines.push(`  saas @ ${saasUrl}: HTTP ${resp.status} (${latency}ms)`);
      }
    }
  } catch (e) {
    lines.push(`  saas: UNREACHABLE — ${(e as Error).message}`);
  }

  // 5. Last 5 ingest log lines
  lines.push('');
  lines.push('INGEST LOG (last 5 lines)');
  const tail = readIngestLogTail(5);
  if (tail.length === 0) {
    lines.push('  (no entries)');
  } else {
    for (const l of tail) {
      lines.push(`  ${l}`);
    }
  }

  // 6. Pending queue stats
  const pending = pendingStats();

  // 7. Env deprecation — snapshot of alias hit counts accumulated BEFORE doctor ran.
  //    buildDeprecationHits() only reads the in-process counter map; it does NOT
  //    call resolveEnv(), so it cannot inflate the counts during this run.
  const deprecationHits = buildDeprecationHits();

  if (jsonMode) {
    const output = {
      env_vars: Object.fromEntries(
        (['MEMORY_BEARER', 'MEMORY_API_URL', 'ASTRAMEM_PROVIDER'] as const).map((v) => [
          v,
          v === 'MEMORY_BEARER'
            ? process.env[v]
              ? '[present, redacted]'
              : null
            : process.env[v] ?? null,
        ]),
      ),
      local_url: localUrl,
      local_url_source: localUrlResolution.source,
      pending: {
        count: pending.count,
        bytes: pending.bytes,
        oldest_epoch_ms: pending.oldest_epoch_ms,
        rejected_count: pending.rejected_count,
      },
      deprecation_hits: deprecationHits,
    };
    process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    return 0;
  }

  // 6. Pending queue (human-readable)
  lines.push('');
  lines.push('PENDING');
  if (pending.count === 0 && pending.rejected_count === 0) {
    lines.push('  count: 0 files (queue empty)');
    lines.push('  rejected: 0 files');
  } else {
    const mb = (pending.bytes / (1024 * 1024)).toFixed(2);
    lines.push(`  count: ${pending.count} file${pending.count === 1 ? '' : 's'} (${mb} MB)`);
    if (pending.oldest_epoch_ms !== null) {
      const oldestDate = new Date(pending.oldest_epoch_ms);
      const ageMs = Date.now() - pending.oldest_epoch_ms;
      const ageHours = (ageMs / (1000 * 60 * 60)).toFixed(1);
      lines.push(`  oldest: ${oldestDate.toISOString().replace('T', ' ').slice(0, 19)} (age: ${ageHours}h)`);
    }
    lines.push(`  rejected: ${pending.rejected_count} file${pending.rejected_count === 1 ? '' : 's'}`);
  }

  lines.push('');
  lines.push('ENV DEPRECATION');
  if (deprecationHits.length === 0) {
    lines.push('  Env aliases: no deprecated aliases used in this process');
  } else {
    for (const { alias, canonical, hits } of deprecationHits) {
      lines.push(`  DEPRECATED env alias used: ${alias} → ${canonical} (${hits} hit${hits === 1 ? '' : 's'})`);
    }
  }

  lines.push('');
  lines.push('─'.repeat(60));
  lines.push('');

  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}
