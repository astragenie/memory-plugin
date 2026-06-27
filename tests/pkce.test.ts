import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { generateCodeVerifier, generateCodeChallenge } from '../lib/pkce.ts';

describe('pkce', () => {
  it('code challenge is SHA256 of verifier, base64url', () => {
    const verifier = generateCodeVerifier();
    const challenge = generateCodeChallenge(verifier);
    const expected = Buffer.from(createHash('sha256').update(verifier).digest())
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(challenge).toBe(expected);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('verifier is at least 43 chars (RFC 7636)', () => {
    const v = generateCodeVerifier();
    expect(v.length).toBeGreaterThanOrEqual(43);
  });

  it('verifier uses only base64url characters', () => {
    const v = generateCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('S256 challenge round-trip: challenge(verifier) == SHA256(verifier) base64url', () => {
    const verifier = generateCodeVerifier();
    const challenge = generateCodeChallenge(verifier);
    const digest = createHash('sha256').update(verifier).digest();
    const manual = Buffer.from(digest)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(challenge).toBe(manual);
  });
});
