import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HELPER = join(process.cwd(), 'hooks', 'scripts', '_ingest-transcript.sh');

function runScrub(input) {
  const dir = mkdtempSync(join(tmpdir(), 'memory-scrub-'));
  const inputFile = join(dir, 'in.txt');
  writeFileSync(inputFile, input);
  const r = spawnSync('bash', [HELPER, '--scrub-only', inputFile], {
    encoding: 'utf-8',
  });
  if (r.status !== 0) throw new Error(`scrub exited ${r.status}: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

test('redacts JWT', () => {
  // Realistic JWT (typ+alg header) so each segment meets the {20,} length floor
  // used by the canonical scrub pattern (kept symmetric with server-side TranscriptScrubber).
  const r = runScrub('token eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c rest');
  assert.equal(r.hits, 1);
  assert.match(r.text, /\[redacted:jwt\]/);
});

test('redacts AWS key', () => {
  const r = runScrub('AKIAIOSFODNN7EXAMPLE inside');
  assert.equal(r.hits, 1);
  assert.match(r.text, /\[redacted:aws-key\]/);
});

test('redacts Anthropic key', () => {
  const r = runScrub('use sk-ant-api03-abcdefghijklmnopqrstuvwx for auth');
  assert.equal(r.hits, 1);
  assert.match(r.text, /\[redacted:anthropic-key\]/);
});

test('redacts generic api_key= patterns', () => {
  const r = runScrub('config: api_key=ABCDEF1234567890ABCDEF more');
  assert.equal(r.hits, 1);
  assert.match(r.text, /\[redacted:generic-secret\]/);
  assert.doesNotMatch(r.text, /ABCDEF1234567890ABCDEF/);
});

test('passes innocuous text through', () => {
  const r = runScrub('the cosine threshold is 0.82 in MemoryGraphLinker');
  assert.equal(r.hits, 0);
  assert.equal(r.text, 'the cosine threshold is 0.82 in MemoryGraphLinker');
});
