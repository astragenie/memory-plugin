/**
 * scrub-properties.test.ts — property-based scrub tests using fast-check v4.
 *
 * For each labeled category: generate strings KNOWN to contain secrets of that
 * class; property = output does NOT contain the original secret.
 *
 * Also: idempotence property for any arbitrary string input.
 *
 * fast-check v4 API: fc.string({ unit, minLength, maxLength })
 */

import { describe, it } from 'vitest';
import * as fc from 'fast-check';
import { scrub, scrubWithLabels } from '../../src/lib/scrub.ts';

// ---------------------------------------------------------------------------
// Helpers — fc.string({ unit }) replaces fc.stringOf in fast-check v4
// ---------------------------------------------------------------------------

const RUNS = 100;

const UPPER_ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const GOOGLE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

function charSet(chars: string, minLength: number, maxLength: number) {
  return fc.string({ unit: fc.constantFrom(...chars.split('')), minLength, maxLength });
}

// ---------------------------------------------------------------------------
// bearer
// ---------------------------------------------------------------------------

describe('property: bearer', () => {
  it('any bearer token ≥20 base64url chars is redacted', () => {
    fc.assert(
      fc.property(
        charSet(BASE64URL, 20, 60),
        (token) => {
          const input = `Bearer ${token}`;
          const output = scrub(input) as string;
          return !output.includes(token);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// jwt
// ---------------------------------------------------------------------------

describe('property: jwt', () => {
  it('any three-segment jwt-shaped token is redacted', () => {
    fc.assert(
      fc.property(
        fc.tuple(
          charSet(BASE64URL, 20, 40),
          charSet(BASE64URL, 20, 40),
          charSet(BASE64URL, 10, 30),
        ).map(([h, p, sig]) => `eyJ${h}.${p}.${sig}`),
        (jwt) => {
          const output = scrub(`token ${jwt}`) as string;
          return !output.includes(jwt);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// aws-key
// ---------------------------------------------------------------------------

describe('property: aws-key', () => {
  const awsPrefixes = ['AKIA', 'ASIA', 'AROA', 'AIDA', 'AIPA', 'ANPA', 'ANVA', 'APKA', 'ASCA', 'AGPA'] as const;

  it('any valid AWS access key is redacted', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...awsPrefixes),
        charSet(UPPER_ALNUM, 16, 16),
        (prefix, suffix) => {
          const key = `${prefix}${suffix}`;
          const output = scrub(`access_key: ${key} rest`) as string;
          return !output.includes(key);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// anthropic-key
// ---------------------------------------------------------------------------

describe('property: anthropic-key', () => {
  it('any sk-ant-apiNN-<20+> key is redacted', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 99 }).map((n) => String(n).padStart(2, '0')),
        charSet(BASE64URL, 20, 50),
        (num, suffix) => {
          const key = `sk-ant-api${num}-${suffix}`;
          const output = scrub(`config: ${key} rest`) as string;
          return !output.includes(key);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// openai-key
// ---------------------------------------------------------------------------

describe('property: openai-key', () => {
  it('any sk-<20+> key is redacted', () => {
    fc.assert(
      fc.property(
        charSet(BASE64URL, 20, 50),
        (suffix) => {
          const key = `sk-${suffix}`;
          const output = scrub(`OPENAI_API_KEY=${key} `) as string;
          return !output.includes(key);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// github-token
// ---------------------------------------------------------------------------

describe('property: github-token', () => {
  it('any gho_ token with ≥36 chars is redacted', () => {
    fc.assert(
      fc.property(
        charSet(ALNUM, 36, 60),
        (suffix) => {
          const token = `gho_${suffix}`;
          const output = scrub(`token: ${token} `) as string;
          return !output.includes(token);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// stripe-key
// ---------------------------------------------------------------------------

describe('property: stripe-key', () => {
  it('any sk_live_ or sk_test_ key with ≥24 chars is redacted', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('live', 'test'),
        charSet(ALNUM, 24, 40),
        (env, suffix) => {
          const key = `sk_${env}_${suffix}`;
          const output = scrub(`STRIPE=${key} `) as string;
          return !output.includes(key);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// google-api-key
// ---------------------------------------------------------------------------

describe('property: google-api-key', () => {
  it('any AIza<≥35 alphanum/dash/underscore> key is redacted', () => {
    fc.assert(
      fc.property(
        charSet(GOOGLE_CHARS, 35, 40),
        (suffix) => {
          const key = `AIza${suffix}`;
          const output = scrub(`GOOGLE_KEY=${key} `) as string;
          return !output.includes(key);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// secret-kv
// ---------------------------------------------------------------------------

describe('property: secret-kv', () => {
  const keywords = ['api_key', 'api-key', 'password', 'passwd', 'secret_key', 'auth_token', 'refresh_token'] as const;

  it('any keyword=<12+> value is redacted', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...keywords),
        fc.constantFrom('=', ': '),
        charSet(ALNUM, 12, 40),
        (kw, sep, val) => {
          const input = `${kw}${sep}${val} `;
          const output = scrub(input) as string;
          return !output.includes(val);
        },
      ),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// Idempotence — for any string, scrub(scrub(x)) === scrub(x)
// ---------------------------------------------------------------------------

describe('property: idempotence', () => {
  it('scrub(scrub(x)) === scrub(x) for arbitrary strings', () => {
    fc.assert(
      fc.property(fc.string(), (x) => {
        const once = scrub(x) as string;
        const twice = scrub(once) as string;
        return once === twice;
      }),
      { numRuns: RUNS },
    );
  });

  it('scrubWithLabels is idempotent on output string', () => {
    fc.assert(
      fc.property(fc.string(), (x) => {
        const { output: once } = scrubWithLabels(x);
        const { output: twice } = scrubWithLabels(once);
        return once === twice;
      }),
      { numRuns: RUNS },
    );
  });
});
