import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// TODO Wave 2/3: these tests invoke the bash helper directly and require bash on PATH.
// On Windows CI the bash binary is expected via Git Bash / Cygwin.

const HELPER = join(process.cwd(), 'hooks', 'scripts', '_ingest-transcript.sh');

function runScrub(input: string): { hits: number; text: string } {
  const dir = mkdtempSync(join(tmpdir(), 'memory-scrub-'));
  const inputFile = join(dir, 'in.txt');
  writeFileSync(inputFile, input);
  const r = spawnSync('bash', [HELPER, '--scrub-only', inputFile], {
    encoding: 'utf-8',
  });
  if (r.status !== 0) throw new Error(`scrub exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout) as { hits: number; text: string };
}

describe('ingest-scrub (bash helper)', () => {
  it('redacts JWT', () => {
    const r = runScrub('token eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c rest');
    expect(r.hits).toBe(1);
    expect(r.text).toMatch(/\[redacted:jwt\]/);
  });

  it('redacts AWS key', () => {
    const r = runScrub('AKIAIOSFODNN7EXAMPLE inside');
    expect(r.hits).toBe(1);
    expect(r.text).toMatch(/\[redacted:aws-key\]/);
  });

  it('redacts Anthropic key', () => {
    const r = runScrub('use sk-ant-api03-abcdefghijklmnopqrstuvwx for auth');
    expect(r.hits).toBe(1);
    expect(r.text).toMatch(/\[redacted:anthropic-key\]/);
  });

  it('redacts generic api_key= patterns', () => {
    const r = runScrub('config: api_key=ABCDEF1234567890ABCDEF more');
    expect(r.hits).toBe(1);
    expect(r.text).toMatch(/\[redacted:generic-secret\]/);
    expect(r.text).not.toMatch(/ABCDEF1234567890ABCDEF/);
  });

  it('passes innocuous text through', () => {
    const r = runScrub('the cosine threshold is 0.82 in MemoryGraphLinker');
    expect(r.hits).toBe(0);
    expect(r.text).toBe('the cosine threshold is 0.82 in MemoryGraphLinker');
  });
});
