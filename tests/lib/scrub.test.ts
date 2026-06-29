import { describe, it, expect } from 'vitest';
import { scrub, scrubError } from '../../src/lib/scrub.ts';

// 64-character hex token used across tests — must never appear after scrubbing.
const HEX64 = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

describe('scrub — bearer token redaction', () => {
  it('redacts a Bearer token in a plain string', () => {
    const result = scrub(`Authorization: Bearer ${HEX64}`) as string;
    expect(result).not.toContain(HEX64);
    expect(result).toContain('[REDACTED:bearer]');
  });

  it('redacts all 10 occurrences across multiple string locations', () => {
    const locations = [
      `Bearer ${HEX64}`,
      `header: Bearer ${HEX64}`,
      `x-auth: bearer ${HEX64}`,
      `"authorization":"Bearer ${HEX64}"`,
      `Bearer ${HEX64} and Bearer ${HEX64}`,
      `log: bearer ${HEX64} warn`,
      `Bearer ${HEX64}`,
      `Bearer ${HEX64}`,
      `Bearer ${HEX64}`,
      `Bearer ${HEX64}`,
    ];
    // Build a single string with all 10 instances
    const combined = locations.join('\n');
    const result = scrub(combined) as string;
    expect(result).not.toContain(HEX64);
    // Count redaction markers
    const matches = (result.match(/\[REDACTED:bearer\]/g) ?? []).length;
    expect(matches).toBeGreaterThanOrEqual(10);
  });

  it('redacts bearer token embedded in a nested object string value', () => {
    const obj = {
      headers: {
        // 'authorization' is NOT a sensitive key name, so value is string-scrubbed
        authorization: `Bearer ${HEX64}`,
        // 'x-custom' is also not sensitive; bearer inside gets scrubbed
        'x-custom': `prefix Bearer ${HEX64} suffix`,
        // 'token' IS a sensitive key → value becomes '[REDACTED:sensitive-key]'
        token: `Bearer ${HEX64}`,
      },
      data: 'innocuous',
    };
    const result = scrub(obj) as Record<string, unknown>;
    const headers = result['headers'] as Record<string, unknown>;
    // 'authorization' value: bearer string is scrubbed out
    expect(headers['authorization']).not.toContain(HEX64);
    expect(headers['authorization']).toContain('[REDACTED:bearer]');
    // 'x-custom' value: bearer string is scrubbed out
    expect(headers['x-custom']).not.toContain(HEX64);
    // 'token' key: entire value replaced
    expect(headers['token']).toBe('[REDACTED:sensitive-key]');
    // Overall: no hex token anywhere
    expect(JSON.stringify(result)).not.toContain(HEX64);
  });

  it('redacts bearer token inside an array element string', () => {
    const arr = [`Bearer ${HEX64}`, 'safe text', `prefix Bearer ${HEX64} suffix`];
    const result = scrub(arr) as string[];
    for (const s of result) {
      expect(s).not.toContain(HEX64);
    }
  });

  it('redacts bearer token in an error message', () => {
    const err = new Error(`request failed with Bearer ${HEX64}`);
    const result = scrubError(err) as Record<string, unknown>;
    expect(JSON.stringify(result)).not.toContain(HEX64);
  });
});

describe('scrub — sensitive key redaction', () => {
  it('redacts api_key value', () => {
    const result = scrub({ api_key: 'mysecret123' }) as Record<string, unknown>;
    expect(result['api_key']).toBe('[REDACTED:sensitive-key]');
  });

  it('redacts apikey (no separator)', () => {
    const result = scrub({ apikey: 'xyz789' }) as Record<string, unknown>;
    expect(result['apikey']).toBe('[REDACTED:sensitive-key]');
  });

  it('redacts api-key (dash separator)', () => {
    const result = scrub({ 'api-key': 'abc' }) as Record<string, unknown>;
    expect(result['api-key']).toBe('[REDACTED:sensitive-key]');
  });

  it('redacts token field', () => {
    const result = scrub({ token: 'tok_live_abc' }) as Record<string, unknown>;
    expect(result['token']).toBe('[REDACTED:sensitive-key]');
  });

  it('redacts secret field', () => {
    const result = scrub({ secret: 'shhh' }) as Record<string, unknown>;
    expect(result['secret']).toBe('[REDACTED:sensitive-key]');
  });

  it('redacts password field', () => {
    const result = scrub({ password: 'hunter2' }) as Record<string, unknown>;
    expect(result['password']).toBe('[REDACTED:sensitive-key]');
  });

  it('redacts bearer field name', () => {
    const result = scrub({ bearer: 'tok' }) as Record<string, unknown>;
    expect(result['bearer']).toBe('[REDACTED:sensitive-key]');
  });

  it('preserves non-sensitive keys', () => {
    const result = scrub({ username: 'alice', count: 5, active: true }) as Record<string, unknown>;
    expect(result['username']).toBe('alice');
    expect(result['count']).toBe(5);
    expect(result['active']).toBe(true);
  });
});

describe('scrub — nested + mixed structures', () => {
  it('recurses into nested objects', () => {
    const input = {
      config: {
        auth: {
          password: 'secret!',
          retries: 3,
        },
      },
      name: 'test',
    };
    const result = scrub(input) as Record<string, unknown>;
    const auth = (result['config'] as Record<string, unknown>)['auth'] as Record<string, unknown>;
    expect(auth['password']).toBe('[REDACTED:sensitive-key]');
    expect(auth['retries']).toBe(3);
    expect(result['name']).toBe('test');
  });

  it('handles arrays of objects', () => {
    const input = [
      { id: 1, token: 'tok1' },
      { id: 2, name: 'ok' },
    ];
    const result = scrub(input) as Array<Record<string, unknown>>;
    expect(result[0]!['token']).toBe('[REDACTED:sensitive-key]');
    expect(result[0]!['id']).toBe(1);
    expect(result[1]!['name']).toBe('ok');
  });

  it('handles null and primitives without throwing', () => {
    expect(scrub(null)).toBe(null);
    expect(scrub(42)).toBe(42);
    expect(scrub(true)).toBe(true);
    expect(scrub(undefined)).toBe(undefined);
  });
});

describe('scrubError — transcript truncation', () => {
  it('truncates error message strings > 200 chars', () => {
    const longMsg = 'x'.repeat(300);
    const err = new Error(longMsg);
    const result = scrubError(err) as Record<string, unknown>;
    const msg = result['message'] as string;
    expect(msg.length).toBeLessThan(250);
    expect(msg).toContain('[truncated]');
  });

  it('does not truncate strings <= 200 chars', () => {
    const err = new Error('short message');
    const result = scrubError(err) as Record<string, unknown>;
    expect(result['message']).toBe('short message');
  });

  it('scrubs bearer token AND truncates in the same pass', () => {
    const longBearer = `Bearer ${HEX64} ${'x'.repeat(220)}`;
    const err = new Error(longBearer);
    const result = scrubError(err) as Record<string, unknown>;
    const msg = result['message'] as string;
    expect(msg).not.toContain(HEX64);
    expect(msg).toContain('[truncated]');
  });
});
