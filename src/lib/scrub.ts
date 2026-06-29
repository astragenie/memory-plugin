/**
 * scrub.ts — canonical client-side secret redactor for AstraMemory.
 *
 * Rules applied in order to string inputs:
 *  1. STRING_PATTERNS — ordered array of [regex, sentinel, label] tuples.
 *     Applied sequentially; each replaces all matches in the current string.
 *  2. Sensitive object keys — keys matching SENSITIVE_KEY_RE have their values
 *     replaced with SENSITIVE_KEY_SENTINEL (recursive on objects/arrays).
 *
 * API:
 *  scrub(input)              — recursive scrub, returns unknown (back-compat).
 *  scrubWithLabels(input)    — string-only, returns { output, hitsByLabel }.
 *  scrubError(err)           — scrub + truncate for safe error logging.
 *
 * SCRUB_VERSION bumped whenever patterns or sentinel format changes.
 */

export const SCRUB_VERSION = '2';

// ---------------------------------------------------------------------------
// STRING_PATTERNS — ordered, applied left to right.
// Each entry: [regex, sentinel, label]
// ---------------------------------------------------------------------------

export const STRING_PATTERNS: Array<[RegExp, string, string]> = [
  // Bearer tokens — broadened to base64url (catches JWT-as-bearer, opaque tokens)
  [
    /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
    '[REDACTED:bearer]',
    'bearer',
  ],
  // JWT — three base64url segments, first two ≥20 chars
  [
    /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+/g,
    '[REDACTED:jwt]',
    'jwt',
  ],
  // AWS access key IDs — full prefix set per AWS IAM docs
  [
    /\b(?:AKIA|ASIA|AROA|AIDA|AIPA|ANPA|ANVA|APKA|ASCA|AGPA)[A-Z0-9]{16}\b/g,
    '[REDACTED:aws-key]',
    'aws-key',
  ],
  // Anthropic API keys
  [
    /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{20,}/g,
    '[REDACTED:anthropic-key]',
    'anthropic-key',
  ],
  // OpenAI (project + service-account + legacy)
  [
    /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g,
    '[REDACTED:openai-key]',
    'openai-key',
  ],
  // GitHub tokens (PAT, OAuth, App install, refresh, server-to-server)
  [
    /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g,
    '[REDACTED:github-token]',
    'github-token',
  ],
  // GitHub fine-grained PAT
  [
    /\bgithub_pat_[A-Za-z0-9_]{82,}\b/g,
    '[REDACTED:github-token]',
    'github-token',
  ],
  // Slack tokens
  [
    /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    '[REDACTED:slack-token]',
    'slack-token',
  ],
  // Stripe keys
  [
    /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{24,}\b/g,
    '[REDACTED:stripe-key]',
    'stripe-key',
  ],
  // Google API keys — {35,} to handle real key length variation; no trailing \b
  // because keys may end in `-` or `_` which aren't word chars.
  [
    /\bAIza[0-9A-Za-z_-]{35,}/g,
    '[REDACTED:google-api-key]',
    'google-api-key',
  ],
  // PEM private keys (multiline)
  [
    /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    '[REDACTED:private-key]',
    'private-key',
  ],
  // Generic keyword=value — enumerated keywords + : or = separator + value ≥12 chars
  [
    /\b(?:api[_-]?key|api[_-]?secret|access[_-]?key|secret[_-]?key|client[_-]?secret|auth[_-]?token|access[_-]?token|refresh[_-]?token|password|passwd|pwd|bearer|aws[_-]?secret[_-]?access[_-]?key)\s*[:=]\s*["']?([A-Za-z0-9+/=._-]{12,})["']?/gi,
    '[REDACTED:secret-kv]',
    'secret-kv',
  ],
];

// ---------------------------------------------------------------------------
// Sensitive key redaction for object traversal
// ---------------------------------------------------------------------------

const SENSITIVE_KEY_RE = /api[_-]?key|token|bearer|secret|password/i;
const SENSITIVE_KEY_SENTINEL = '[REDACTED:sensitive-key]';

const MAX_STR_LEN = 200;

// ---------------------------------------------------------------------------
// scrubString — apply all STRING_PATTERNS in order to a string.
// Returns { output, hitsByLabel } so callers can aggregate counts.
// ---------------------------------------------------------------------------

function scrubString(input: string): { output: string; hitsByLabel: Record<string, number> } {
  const hitsByLabel: Record<string, number> = {};
  let current = input;

  for (const [regex, sentinel, label] of STRING_PATTERNS) {
    // Reset lastIndex — patterns are module-level and stateful if /g
    regex.lastIndex = 0;
    const matches = current.match(regex);
    if (matches && matches.length > 0) {
      hitsByLabel[label] = (hitsByLabel[label] ?? 0) + matches.length;
      regex.lastIndex = 0;
      current = current.replace(regex, sentinel);
    }
    regex.lastIndex = 0;
  }

  return { output: current, hitsByLabel };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * scrubWithLabels — string-only scrub with per-label hit counts.
 * Throws if input is not a string (callers expecting labels must pass strings).
 */
export function scrubWithLabels(input: string): { output: string; hitsByLabel: Record<string, number> } {
  if (typeof input !== 'string') {
    throw new TypeError(`scrubWithLabels: expected string, got ${typeof input}`);
  }
  return scrubString(input);
}

/**
 * scrub — recursive scrub. Returns unknown (back-compat).
 * Strings: all STRING_PATTERNS applied.
 * Objects: sensitive keys → SENSITIVE_KEY_SENTINEL; values recursed.
 * Arrays: map through scrub.
 * Other: unchanged.
 */
export function scrub(input: unknown): unknown {
  if (typeof input === 'string') {
    return scrubString(input).output;
  }

  if (Array.isArray(input)) {
    return input.map(scrub);
  }

  if (input !== null && typeof input === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(key)) {
        result[key] = SENSITIVE_KEY_SENTINEL;
      } else {
        result[key] = scrub(val);
      }
    }
    return result;
  }

  // Numbers, booleans, null, undefined — pass through unchanged.
  return input;
}

/**
 * scrubError — scrub an error value for safe logging.
 * Serialises the error to a plain object, scrubs it, then truncates
 * any remaining string values > 200 chars (to prevent transcript bloat).
 */
export function scrubError(err: unknown): unknown {
  const serialised = serializeError(err);
  const scrubbed = scrub(serialised);
  return truncateStrings(scrubbed, MAX_STR_LEN);
}

// ---------------------------------------------------------------------------
// Back-compat export: BEARER_RE
// The old regex is superseded by STRING_PATTERNS[0] which broadens to base64url.
// Kept as a named export so any callers that imported it don't break at compile time.
// @deprecated — use scrubWithLabels() or scrub() instead.
// ---------------------------------------------------------------------------
export const BEARER_RE = STRING_PATTERNS[0]![0];

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack,
      ...(err.cause !== undefined ? { cause: serializeError(err.cause) } : {}),
    };
  }
  if (typeof err === 'string') {
    return { message: err };
  }
  if (err !== null && typeof err === 'object') {
    return { ...err as Record<string, unknown> };
  }
  return { value: String(err) };
}

function truncateStrings(input: unknown, maxLen: number): unknown {
  if (typeof input === 'string') {
    return input.length > maxLen ? input.slice(0, maxLen) + '…[truncated]' : input;
  }
  if (Array.isArray(input)) {
    return input.map((el) => truncateStrings(el, maxLen));
  }
  if (input !== null && typeof input === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
      result[key] = truncateStrings(val, maxLen);
    }
    return result;
  }
  return input;
}
