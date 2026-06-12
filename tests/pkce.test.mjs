import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { generateCodeVerifier, generateCodeChallenge } from '../lib/pkce.mjs';

test('code challenge is SHA256 of verifier, base64url', () => {
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  const expected = Buffer.from(createHash('sha256').update(verifier).digest())
    .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  assert.equal(challenge, expected);
  assert.match(challenge, /^[A-Za-z0-9_-]+$/);
});

test('verifier is at least 43 chars (RFC 7636)', () => {
  const v = generateCodeVerifier();
  assert.ok(v.length >= 43, `verifier length ${v.length} should be >= 43`);
});

test('verifier uses only base64url characters', () => {
  const v = generateCodeVerifier();
  assert.match(v, /^[A-Za-z0-9_-]+$/, 'verifier must be base64url encoded');
});

test('S256 challenge round-trip: challenge(verifier) == SHA256(verifier) base64url', () => {
  const verifier = generateCodeVerifier();
  const challenge = generateCodeChallenge(verifier);
  // Recompute manually
  const digest = createHash('sha256').update(verifier).digest();
  const manual = Buffer.from(digest)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  assert.equal(challenge, manual, 'S256 round-trip must produce identical output');
});
