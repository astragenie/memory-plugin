/**
 * Fixture replay tests — Slice 2 (FEAT 4a §5.2 blocking gate).
 *
 * For each fixture in tests/hooks/fixtures/:
 *   1. Read hook-stdin.json and extract fields (same as the bash shim does via jq).
 *   2. Rewrite transcript_path to the fixture's transcript.jsonl absolute path.
 *   3. Build CLI argv and run runIngestTranscript() with a MockProvider.
 *   4. Replace non-deterministic fields in the captured envelope with sentinels.
 *   5. Deep-equal compare against golden-envelope.json.
 *
 * This is the byte-identical gate: migration is NOT done until every fixture passes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { runIngestTranscript } from '../../src/cli/ingest-transcript.ts';
import { createMockProvider } from '../cli/mock-provider.ts';
import type { TranscriptIngestPayload } from '../../src/contracts/wire.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FIXTURE_ROOT = join(import.meta.dirname, 'fixtures');
const SENTINEL_CAPTURED_AT = '__SENTINEL_CAPTURED_AT__';
const SENTINEL_CLIENT_VERSION = '__SENTINEL_CLIENT_VERSION__';
const SENTINEL_SCRUB_VERSION = '__SENTINEL_SCRUB_VERSION__';

// ---------------------------------------------------------------------------
// Environment isolation (redirect APPDATA/HOME so log writes stay in temp)
// ---------------------------------------------------------------------------

let tmpDir: string;
let savedAppData: string | undefined;
let savedHome: string | undefined;

function isolateEnv(): void {
  tmpDir = mkdtempSync(join(tmpdir(), 'astramem-fr-'));
  savedAppData = process.env['APPDATA'];
  savedHome = process.env['HOME'];
  process.env['APPDATA'] = tmpDir;
  if (process.platform !== 'win32') {
    process.env['HOME'] = tmpDir;
  }
}

function restoreEnv(): void {
  if (savedAppData !== undefined) {
    process.env['APPDATA'] = savedAppData;
  } else {
    delete process.env['APPDATA'];
  }
  if (process.platform !== 'win32') {
    if (savedHome !== undefined) {
      process.env['HOME'] = savedHome;
    } else {
      delete process.env['HOME'];
    }
  }
  if (tmpDir && existsSync(tmpDir)) {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Replace the two non-deterministic sentinel fields before deep-equal. */
function applySentinels(envelope: TranscriptIngestPayload): TranscriptIngestPayload {
  return {
    ...envelope,
    captured_at: SENTINEL_CAPTURED_AT,
    client_version: SENTINEL_CLIENT_VERSION,
    client_scrub_version: SENTINEL_SCRUB_VERSION,
  };
}

/** Read and parse JSON from an absolute path. */
function readJson<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
}

interface HookStdin {
  session_id: string;
  transcript_path: string;
  cwd?: string;
  agent_type?: string;
  hook_event_name: string;
  [key: string]: unknown;
}

/**
 * Run one fixture through the CLI and return the envelope passed to the mock provider.
 * Mirrors the jq field-extraction that the bash shim does (§4.1.1 lines 129-132):
 *   TRANSCRIPT_PATH = .transcript_path // empty
 *   SESSION_ID      = .session_id // "unknown"
 *   CWD             = .cwd // empty
 *   AGENT_TYPE      = .agent_type // empty
 *   PROJECT_ID      = basename(CWD)
 */
async function replayFixture(
  fixturePath: string,
  event: 'pre_compact' | 'session_end' | 'subagent_stop',
  overrides: { maxTurns?: number } = {},
): Promise<TranscriptIngestPayload | undefined> {
  const stdinPath = join(fixturePath, 'hook-stdin.json');
  const transcriptPath = join(fixturePath, 'transcript.jsonl');

  // Read hook stdin JSON — the payload Claude Code passes on stdin.
  const stdinData = readJson<HookStdin>(stdinPath);

  // Extract fields exactly as the bash shim does (§4.1.1).
  // transcript_path from fixture is a sentinel; use actual fixture transcript.
  const transcriptPathResolved = transcriptPath;
  const sessionId: string = stdinData['session_id'] ?? 'unknown';
  const cwd: string | undefined = stdinData['cwd'] ?? undefined;
  const agentType: string | undefined =
    typeof stdinData['agent_type'] === 'string' && stdinData['agent_type'].length > 0
      ? stdinData['agent_type']
      : undefined;
  const projectId: string = cwd ? basename(cwd) : 'unknown';

  // Build CLI argv (same as the bash shim exec line).
  const argv: string[] = [
    '--event', event,
    '--transcript-path', transcriptPathResolved,
    '--session-id', sessionId,
    '--project-id', projectId,
    '--cwd', cwd ?? '',
    '--max-turns', String(overrides.maxTurns ?? 20),
    '--max-chars', '12000',
  ];
  if (agentType !== undefined) {
    argv.push('--agent-type', agentType);
  }

  const provider = createMockProvider();
  const code = await runIngestTranscript(argv, { _provider: provider });

  expect(code).toBe(0);

  if (provider._stubs.ingestTranscript.mock.calls.length === 0) {
    return undefined;
  }
  return provider._stubs.ingestTranscript.mock.calls[0]![0] as TranscriptIngestPayload;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('fixture-replay — hook payload golden-body gate (FEAT 4a §5.2)', () => {
  beforeEach(isolateEnv);
  afterEach(restoreEnv);

  // -------------------------------------------------------------------------
  // pre_compact / 01-basic
  // -------------------------------------------------------------------------

  it('pre_compact/01-basic: basic 2-turn envelope matches golden', async () => {
    const fixturePath = join(FIXTURE_ROOT, 'pre_compact', '01-basic');
    const actual = await replayFixture(fixturePath, 'pre_compact');
    expect(actual).toBeDefined();
    const golden = readJson<TranscriptIngestPayload>(join(fixturePath, 'golden-envelope.json'));
    expect(applySentinels(actual!)).toEqual(golden);
  });

  // -------------------------------------------------------------------------
  // pre_compact / 02-multi-turn (15 turns in file, --max-turns 5, golden has 5)
  // -------------------------------------------------------------------------

  it('pre_compact/02-multi-turn: --max-turns 5 tails to last 5 turns', async () => {
    const fixturePath = join(FIXTURE_ROOT, 'pre_compact', '02-multi-turn');
    const actual = await replayFixture(fixturePath, 'pre_compact', { maxTurns: 5 });
    expect(actual).toBeDefined();
    expect(actual!.turns).toHaveLength(5);
    const golden = readJson<TranscriptIngestPayload>(join(fixturePath, 'golden-envelope.json'));
    expect(applySentinels(actual!)).toEqual(golden);
  });

  // -------------------------------------------------------------------------
  // pre_compact / 03-bearer-in-text (scrub gate)
  // -------------------------------------------------------------------------

  it('pre_compact/03-bearer-in-text: bearer token scrubbed; client_scrub_hits=1', async () => {
    const fixturePath = join(FIXTURE_ROOT, 'pre_compact', '03-bearer-in-text');
    const actual = await replayFixture(fixturePath, 'pre_compact');
    expect(actual).toBeDefined();
    // No raw bearer token survives in any turn text.
    for (const turn of actual!.turns) {
      expect(turn.text).not.toMatch(/Bearer\s+[A-Fa-f0-9]{32,}/);
    }
    expect(actual!.client_scrub_hits).toBe(1);
    const golden = readJson<TranscriptIngestPayload>(join(fixturePath, 'golden-envelope.json'));
    expect(applySentinels(actual!)).toEqual(golden);
  });

  // -------------------------------------------------------------------------
  // session_end / 01-basic
  // -------------------------------------------------------------------------

  it('session_end/01-basic: session_end event with 4 turns matches golden', async () => {
    const fixturePath = join(FIXTURE_ROOT, 'session_end', '01-basic');
    const actual = await replayFixture(fixturePath, 'session_end');
    expect(actual).toBeDefined();
    expect(actual!.event).toBe('session_end');
    const golden = readJson<TranscriptIngestPayload>(join(fixturePath, 'golden-envelope.json'));
    expect(applySentinels(actual!)).toEqual(golden);
  });

  // -------------------------------------------------------------------------
  // subagent_stop / 01-basic (empty agent_type → field omitted)
  // -------------------------------------------------------------------------

  it('subagent_stop/01-basic: empty agent_type omitted from envelope', async () => {
    const fixturePath = join(FIXTURE_ROOT, 'subagent_stop', '01-basic');
    const actual = await replayFixture(fixturePath, 'subagent_stop');
    expect(actual).toBeDefined();
    expect(actual!.event).toBe('subagent_stop');
    expect(actual!.agent_type).toBeUndefined();
    const golden = readJson<TranscriptIngestPayload>(join(fixturePath, 'golden-envelope.json'));
    expect(applySentinels(actual!)).toEqual(golden);
  });

  // -------------------------------------------------------------------------
  // subagent_stop / 02-with-agent-type (non-empty agent_type → in envelope)
  // -------------------------------------------------------------------------

  it('subagent_stop/02-with-agent-type: agent_type present in envelope', async () => {
    const fixturePath = join(FIXTURE_ROOT, 'subagent_stop', '02-with-agent-type');
    const actual = await replayFixture(fixturePath, 'subagent_stop');
    expect(actual).toBeDefined();
    expect(actual!.agent_type).toBe('crew:aiplugin-dev');
    const golden = readJson<TranscriptIngestPayload>(join(fixturePath, 'golden-envelope.json'));
    expect(applySentinels(actual!)).toEqual(golden);
  });

  // -------------------------------------------------------------------------
  // subagent_stop / 03-real-claude-transcript (real nested JSONL shape gate)
  // -------------------------------------------------------------------------

  it('subagent_stop/03-real-claude-transcript: real nested JSONL shape — tool_use/system/tool_result filtered; only text turns in envelope', async () => {
    const fixturePath = join(FIXTURE_ROOT, 'subagent_stop', '03-real-claude-transcript');
    const actual = await replayFixture(fixturePath, 'subagent_stop');
    expect(actual).toBeDefined();
    expect(actual!.event).toBe('subagent_stop');
    // 5 turns: user(str) + assistant(text-block) + assistant(text+tool_use) +
    //          user(str) + assistant(text-block). tool_result and pure-tool_use lines dropped.
    expect(actual!.turns).toHaveLength(5);
    // All extracted turns must have non-empty text (no empty strings survived)
    for (const turn of actual!.turns) {
      expect(turn.text.length).toBeGreaterThan(0);
    }
    const golden = readJson<TranscriptIngestPayload>(join(fixturePath, 'golden-envelope.json'));
    expect(applySentinels(actual!)).toEqual(golden);
  });
});
