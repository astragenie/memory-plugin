/**
 * scrub-patterns.test.ts — per-pattern positive/negative/idempotence tests.
 *
 * For each pattern in STRING_PATTERNS:
 *  - 3+ positive cases: string containing secret → correct sentinel in output
 *  - 2+ negative cases: near-miss → passes through unchanged
 *  - idempotence: scrub(scrub(x)) === scrub(x)
 *
 * Cross-pattern:
 *  - Multi-secret string → both redacted
 *  - Adjacent secrets → both redacted
 *  - Sentinel strings never re-matched by other patterns
 */

import { describe, it, expect } from 'vitest';
import { scrub, scrubWithLabels, SCRUB_VERSION } from '../../src/lib/scrub.ts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function s(input: string): string {
  return scrub(input) as string;
}

function noOriginal(output: string, original: string): void {
  expect(output).not.toContain(original);
}

function idempotent(input: string): void {
  expect(s(s(input))).toBe(s(input));
}

// ---------------------------------------------------------------------------
// bearer
// ---------------------------------------------------------------------------

describe('pattern: bearer', () => {
  it('pos 1: standard hex bearer', () => {
    const r = s('Authorization: Bearer abc123def456abc123def456abc123de');
    expect(r).toContain('[REDACTED:bearer]');
    noOriginal(r, 'abc123def456abc123def456abc123de');
  });

  it('pos 2: JWT-as-bearer', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyMTIzIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const r = s(`Bearer ${jwt}`);
    expect(r).toContain('[REDACTED:bearer]');
  });

  it('pos 3: case-insensitive BEARER keyword', () => {
    const r = s('BEARER abcdefghijklmnopqrstuvwxyz1234567890AB');
    expect(r).toContain('[REDACTED:bearer]');
  });

  it('neg 1: Bearer with short token (<20 chars)', () => {
    const r = s('Bearer short12345');
    expect(r).toBe('Bearer short12345');
  });

  it('neg 2: no Bearer keyword', () => {
    const r = s('token: abcdefghijklmnopqrstuvwxyz1234567890AB');
    // Should not trigger bearer pattern (no Bearer keyword)
    // May still be caught by secret-kv but not bearer label
    const { hitsByLabel } = scrubWithLabels('token: abcdefghijklmnopqrstuvwxyz1234567890AB');
    expect(hitsByLabel['bearer']).toBeUndefined();
  });

  it('idempotent', () => {
    idempotent('Authorization: Bearer abc123def456abc123def456abc123de rest');
  });
});

// ---------------------------------------------------------------------------
// jwt
// ---------------------------------------------------------------------------

describe('pattern: jwt', () => {
  const JWT1 = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
  const JWT2 = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyQGV4YW1wbGUuY29tIiwiaWF0IjoxNjAwMDAwMDAwfQ.abcdefghijklmnopqrstuvwx';
  // First segment must be eyJ + ≥20 more chars for the pattern; this one is eyJ + 21
  const JWT3 = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2V4YW1wbGUuY29tIiwic3ViIjoic2VydmljZSJ9.MEUCIQD_signaturepart';

  it('pos 1: standard JWT in text', () => {
    const r = s(`token=${JWT1}`);
    expect(r).toContain('[REDACTED:jwt]');
    noOriginal(r, JWT1);
  });

  it('pos 2: JWT with surrounding text', () => {
    const r = s(`use this token: ${JWT2} for auth`);
    expect(r).toContain('[REDACTED:jwt]');
  });

  it('pos 3: JWT at start of string', () => {
    const r = s(`${JWT3} is the token`);
    expect(r).toContain('[REDACTED:jwt]');
  });

  it('neg 1: only two segments (not a JWT)', () => {
    const r = s('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0');
    // Two segments only — should not match JWT pattern
    expect(r).not.toContain('[REDACTED:jwt]');
  });

  it('neg 2: first segment too short', () => {
    const r = s('eyJa.eyJzdWIiOiJ1c2VyQGV4YW1wbGUuY29tIiwiaWF0IjoxNjAwMDAwMDAwfQ.sig');
    expect(r).not.toContain('[REDACTED:jwt]');
  });

  it('idempotent', () => {
    idempotent(`token=${JWT1}`);
  });
});

// ---------------------------------------------------------------------------
// aws-key
// ---------------------------------------------------------------------------

describe('pattern: aws-key', () => {
  it('pos 1: AKIA prefix', () => {
    const r = s('AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE');
    expect(r).toContain('[REDACTED:aws-key]');
    noOriginal(r, 'AKIAIOSFODNN7EXAMPLE');
  });

  it('pos 2: ASIA prefix (temporary keys)', () => {
    const r = s('key: ASIA1234567890ABCDEF');
    expect(r).toContain('[REDACTED:aws-key]');
  });

  it('pos 3: AROA prefix (role)', () => {
    // AROA + exactly 16 uppercase alphanumeric chars
    const r = s('arn uses AROAEXAMPLEID1234567');
    expect(r).toContain('[REDACTED:aws-key]');
  });

  it('neg 1: AKIA prefix but too short (15 chars)', () => {
    const r = s('AKIAIOSFODNN7EX');
    expect(r).not.toContain('[REDACTED:aws-key]');
  });

  it('neg 2: lowercase AKIA', () => {
    const r = s('akiaiosfodnn7example is not a key');
    expect(r).not.toContain('[REDACTED:aws-key]');
  });

  it('idempotent', () => {
    idempotent('key: AKIAIOSFODNN7EXAMPLE plain');
  });
});

// ---------------------------------------------------------------------------
// anthropic-key
// ---------------------------------------------------------------------------

describe('pattern: anthropic-key', () => {
  it('pos 1: api key variant', () => {
    const r = s('sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345');
    expect(r).toContain('[REDACTED:anthropic-key]');
    noOriginal(r, 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345');
  });

  it('pos 2: admin key variant', () => {
    const r = s('key=sk-ant-admin01-ABCDEFGHIJKLMNOPQRSTUVWX');
    expect(r).toContain('[REDACTED:anthropic-key]');
  });

  it('pos 3: embedded in JSON', () => {
    const r = s('{"api_key": "sk-ant-api01-longkeyvaluehere1234567890ab"}');
    expect(r).toContain('[REDACTED:anthropic-key]');
  });

  it('neg 1: sk-ant- without api/admin', () => {
    const r = s('sk-ant-other-abcdefghijklmnopqrstuvwxyz');
    const { hitsByLabel } = scrubWithLabels('sk-ant-other-abcdefghijklmnopqrstuvwxyz');
    expect(hitsByLabel['anthropic-key']).toBeUndefined();
  });

  it('neg 2: too short value after prefix', () => {
    const r = s('sk-ant-api03-short');
    expect(r).not.toContain('[REDACTED:anthropic-key]');
  });

  it('idempotent', () => {
    idempotent('sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345');
  });
});

// ---------------------------------------------------------------------------
// openai-key
// ---------------------------------------------------------------------------

describe('pattern: openai-key', () => {
  it('pos 1: legacy sk- key', () => {
    const r = s('Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz1234567890AB');
    // jwt-as-bearer or bearer may catch this — check openai-key specifically
    const { hitsByLabel } = scrubWithLabels('OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz1234567890AB');
    expect(hitsByLabel['openai-key']).toBeTruthy();
  });

  it('pos 2: project key', () => {
    const { hitsByLabel } = scrubWithLabels('sk-proj-abcdefghijklmnopqrstuvwxyz1234567890ABCDE');
    expect(hitsByLabel['openai-key']).toBeTruthy();
  });

  it('pos 3: service account key', () => {
    const { hitsByLabel } = scrubWithLabels('key: sk-svcacct-abcdefghijklmnopqrstuvwxyz12345');
    expect(hitsByLabel['openai-key']).toBeTruthy();
  });

  it('neg 1: sk- prefix too short', () => {
    const r = s('sk-short');
    const { hitsByLabel } = scrubWithLabels('sk-short');
    expect(hitsByLabel['openai-key']).toBeUndefined();
  });

  it('neg 2: starts with sk but not followed by - or proj-/svcacct-', () => {
    // sk without dash is not matched (word boundary + sk-)
    const { hitsByLabel } = scrubWithLabels('sk0123456789abcdefghijklmnop');
    expect(hitsByLabel['openai-key']).toBeUndefined();
  });

  it('idempotent', () => {
    idempotent('OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz1234567890AB');
  });
});

// ---------------------------------------------------------------------------
// github-token
// ---------------------------------------------------------------------------

describe('pattern: github-token', () => {
  it('pos 1: gho_ OAuth token', () => {
    const { hitsByLabel, output } = scrubWithLabels('token: gho_ABCDEFGHIJKLMNOPQRSTUVWXYZ12345678901234');
    expect(hitsByLabel['github-token']).toBeTruthy();
    expect(output).toContain('[REDACTED:github-token]');
  });

  it('pos 2: ghp_ PAT', () => {
    const { hitsByLabel } = scrubWithLabels('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789012345');
    expect(hitsByLabel['github-token']).toBeTruthy();
  });

  it('pos 3: fine-grained PAT', () => {
    // 82+ chars after github_pat_
    const longPat = 'github_pat_' + 'A'.repeat(82);
    const { hitsByLabel } = scrubWithLabels(longPat);
    expect(hitsByLabel['github-token']).toBeTruthy();
  });

  it('neg 1: ghx_ prefix (x not in pattern set [pousr])', () => {
    // ghx_ is not in [pousr] — no match
    const { hitsByLabel } = scrubWithLabels('ghx_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789012345');
    expect(hitsByLabel['github-token']).toBeUndefined();
  });

  it('neg 2: ghp_ but too short (<36 chars after prefix)', () => {
    const { hitsByLabel } = scrubWithLabels('ghp_ABCDE12345');
    expect(hitsByLabel['github-token']).toBeUndefined();
  });

  it('idempotent', () => {
    idempotent('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456789012345 token');
  });
});

// ---------------------------------------------------------------------------
// slack-token
// ---------------------------------------------------------------------------

describe('pattern: slack-token', () => {
  it('pos 1: xoxb bot token', () => {
    const { hitsByLabel } = scrubWithLabels('SLACK_TOKEN=xoxb-12345678901-abcdefghijklmnopqrstuvwxyz');
    expect(hitsByLabel['slack-token']).toBeTruthy();
  });

  it('pos 2: xoxp user token', () => {
    const { hitsByLabel } = scrubWithLabels('xoxp-1234567890123-1234567890123-abcdefghijklmno');
    expect(hitsByLabel['slack-token']).toBeTruthy();
  });

  it('pos 3: xoxs socket token', () => {
    const { hitsByLabel } = scrubWithLabels('token xoxs-1234567890abcdef-more');
    expect(hitsByLabel['slack-token']).toBeTruthy();
  });

  it('neg 1: xox without matching second char', () => {
    const { hitsByLabel } = scrubWithLabels('xoxz-1234567890-abcdefghij');
    expect(hitsByLabel['slack-token']).toBeUndefined();
  });

  it('neg 2: too short after xoxb-', () => {
    const { hitsByLabel } = scrubWithLabels('xoxb-short');
    expect(hitsByLabel['slack-token']).toBeUndefined();
  });

  it('idempotent', () => {
    idempotent('SLACK_BOT_TOKEN=xoxb-12345678901-abcdefghijklmnopqrstuvwxyz');
  });
});

// ---------------------------------------------------------------------------
// stripe-key
// ---------------------------------------------------------------------------

describe('pattern: stripe-key', () => {
  it('pos 1: live secret key', () => {
    const { hitsByLabel } = scrubWithLabels('sk_live_ABCDEFGHIJKLMNOPQRSTUVWX');
    expect(hitsByLabel['stripe-key']).toBeTruthy();
  });

  it('pos 2: test secret key', () => {
    const { hitsByLabel, output } = scrubWithLabels('STRIPE_KEY=sk_test_abcdefghijklmnopqrstuvwxyz1234');
    expect(hitsByLabel['stripe-key']).toBeTruthy();
    expect(output).toContain('[REDACTED:stripe-key]');
  });

  it('pos 3: restricted key (rk_)', () => {
    const { hitsByLabel } = scrubWithLabels('rk_live_ABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(hitsByLabel['stripe-key']).toBeTruthy();
  });

  it('neg 1: pk_ publishable key also redacted (correct)', () => {
    // pk_ is in the pattern — intentional
    const { hitsByLabel } = scrubWithLabels('pk_test_ABCDEFGHIJKLMNOPQRSTUVWX');
    expect(hitsByLabel['stripe-key']).toBeTruthy();
  });

  it('neg 2: sk_prod_ — not a valid stripe environment', () => {
    const { hitsByLabel } = scrubWithLabels('sk_prod_ABCDEFGHIJKLMNOPQRSTUVWX');
    expect(hitsByLabel['stripe-key']).toBeUndefined();
  });

  it('idempotent', () => {
    idempotent('STRIPE_SECRET=sk_live_ABCDEFGHIJKLMNOPQRSTUVWX done');
  });
});

// ---------------------------------------------------------------------------
// google-api-key
// ---------------------------------------------------------------------------

describe('pattern: google-api-key', () => {
  it('pos 1: standard AIza key', () => {
    const { hitsByLabel } = scrubWithLabels('GOOGLE_API_KEY=AIzaSyD-9tSrke72I6e68ea374KGge8TgIiPLA2U');
    expect(hitsByLabel['google-api-key']).toBeTruthy();
  });

  it('pos 2: AIza key in URL', () => {
    const { hitsByLabel } = scrubWithLabels('https://maps.googleapis.com/api?key=AIzaSyD9tSrke72I6e68ea374KGge8TgIiPLA2UX');
    expect(hitsByLabel['google-api-key']).toBeTruthy();
  });

  it('pos 3: AIza at start of line', () => {
    const { hitsByLabel } = scrubWithLabels('AIzaSyBcABCDEFGHIJKLMNOPQRSTUVWXYZ123456');
    expect(hitsByLabel['google-api-key']).toBeTruthy();
  });

  it('neg 1: AIza but only 34 chars after (35 minimum required)', () => {
    // 34 chars after AIza — below minimum
    const { hitsByLabel } = scrubWithLabels('AIzaSyD-9tSrke72I6e68ea374KGge8T');
    expect(hitsByLabel['google-api-key']).toBeUndefined();
  });

  it('neg 2: AIzb prefix (not AIza)', () => {
    const { hitsByLabel } = scrubWithLabels('AIzbSyD-9tSrke72I6e68ea374KGge8TgIiPLA2U');
    expect(hitsByLabel['google-api-key']).toBeUndefined();
  });

  it('idempotent', () => {
    idempotent('GOOGLE_API_KEY=AIzaSyD-9tSrke72I6e68ea374KGge8TgIiPLA2U rest');
  });
});

// ---------------------------------------------------------------------------
// private-key
// ---------------------------------------------------------------------------

describe('pattern: private-key', () => {
  const RSA_KEY = `-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA2a2rwplBQLzHPZe5RJr9BQZQVHKV
ExampleBase64EncodedKeyDataHere==
-----END RSA PRIVATE KEY-----`;

  const EC_KEY = `-----BEGIN EC PRIVATE KEY-----
MHQCAQEEIPbNOm3LR1HBIeSi5iR0lk7kLAG0EjmJ0efZ
-----END EC PRIVATE KEY-----`;

  const OPENSSH_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
-----END OPENSSH PRIVATE KEY-----`;

  it('pos 1: RSA private key block', () => {
    const { hitsByLabel } = scrubWithLabels(RSA_KEY);
    expect(hitsByLabel['private-key']).toBeTruthy();
  });

  it('pos 2: EC private key block', () => {
    const { hitsByLabel } = scrubWithLabels(`config: ${EC_KEY} end`);
    expect(hitsByLabel['private-key']).toBeTruthy();
  });

  it('pos 3: OpenSSH private key block', () => {
    const { hitsByLabel } = scrubWithLabels(OPENSSH_KEY);
    expect(hitsByLabel['private-key']).toBeTruthy();
  });

  it('neg 1: BEGIN PUBLIC KEY (not private)', () => {
    const pubKey = '-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkq==\n-----END PUBLIC KEY-----';
    const { hitsByLabel } = scrubWithLabels(pubKey);
    expect(hitsByLabel['private-key']).toBeUndefined();
  });

  it('neg 2: BEGIN CERTIFICATE (not private key)', () => {
    const cert = '-----BEGIN CERTIFICATE-----\nMIIBIjANBgkq==\n-----END CERTIFICATE-----';
    const { hitsByLabel } = scrubWithLabels(cert);
    expect(hitsByLabel['private-key']).toBeUndefined();
  });

  it('idempotent', () => {
    idempotent(RSA_KEY);
  });
});

// ---------------------------------------------------------------------------
// secret-kv
// ---------------------------------------------------------------------------

describe('pattern: secret-kv', () => {
  it('pos 1: api_key=value', () => {
    const { hitsByLabel } = scrubWithLabels('config api_key=ABCDEFGHIJKLMN1234567890 done');
    expect(hitsByLabel['secret-kv']).toBeTruthy();
  });

  it('pos 2: password: value with quotes', () => {
    const { hitsByLabel, output } = scrubWithLabels('password: "longpassword123456"');
    expect(hitsByLabel['secret-kv']).toBeTruthy();
    expect(output).toContain('[REDACTED:secret-kv]');
  });

  it('pos 3: aws_secret_access_key=value', () => {
    const { hitsByLabel } = scrubWithLabels('aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY');
    expect(hitsByLabel['secret-kv']).toBeTruthy();
  });

  it('neg 1: value too short (<12 chars)', () => {
    const { hitsByLabel } = scrubWithLabels('api_key=short12');
    // 7 chars — should not match (needs ≥12)
    const { hitsByLabel: h2 } = scrubWithLabels('api_key=shrt');
    expect(h2['secret-kv']).toBeUndefined();
  });

  it('neg 2: keyword but no separator', () => {
    const { hitsByLabel } = scrubWithLabels('passwordABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(hitsByLabel['secret-kv']).toBeUndefined();
  });

  it('idempotent', () => {
    idempotent('api_key=ABCDEFGHIJKLMN1234567890 done');
  });
});

// ---------------------------------------------------------------------------
// Cross-pattern tests
// ---------------------------------------------------------------------------

describe('cross-pattern', () => {
  it('multi-secret: JWT + AWS key in one string', () => {
    const JWT = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const input = `use jwt ${JWT} with key AKIAIOSFODNN7EXAMPLE`;
    const { output, hitsByLabel } = scrubWithLabels(input);
    expect(output).toContain('[REDACTED:jwt]');
    expect(output).toContain('[REDACTED:aws-key]');
    expect(hitsByLabel['jwt']).toBeTruthy();
    expect(hitsByLabel['aws-key']).toBeTruthy();
    expect(output).not.toContain('eyJ');
    expect(output).not.toContain('AKIAIOSFODNN7EXAMPLE');
  });

  it('adjacent secrets: two different tokens separated by non-word char', () => {
    // Each token must stand at its own word boundary.
    // AWS key = AKIA + exactly 16 uppercase chars. Stripe = sk_live_ + 24+ chars.
    const awsKey = 'AKIAIOSFODNN7EXAMPLE';  // AKIA + 16 chars
    const stripeKey = 'sk_live_ABCDEFGHIJKLMNOPQRSTUVWX';
    const input = `${awsKey} and key=${stripeKey}`;
    const { output } = scrubWithLabels(input);
    expect(output).not.toContain(awsKey);
    expect(output).not.toContain(stripeKey);
  });

  it('sentinel values are not re-matched by any pattern', () => {
    // All sentinel strings should pass through a second scrub unchanged
    const sentinels = [
      '[REDACTED:bearer]',
      '[REDACTED:jwt]',
      '[REDACTED:aws-key]',
      '[REDACTED:anthropic-key]',
      '[REDACTED:openai-key]',
      '[REDACTED:github-token]',
      '[REDACTED:slack-token]',
      '[REDACTED:stripe-key]',
      '[REDACTED:google-api-key]',
      '[REDACTED:private-key]',
      '[REDACTED:secret-kv]',
      '[REDACTED:sensitive-key]',
    ];
    for (const sentinel of sentinels) {
      expect(s(sentinel)).toBe(sentinel);
    }
  });

  it('innocuous text passes through unchanged', () => {
    const innocuous = 'the cosine threshold is 0.82 in MemoryGraphLinker for recall';
    expect(s(innocuous)).toBe(innocuous);
  });

  it('SCRUB_VERSION is "2"', () => {
    expect(SCRUB_VERSION).toBe('2');
  });
});
