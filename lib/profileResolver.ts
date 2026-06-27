// Profile and token resolver for the memory-connect device-flow pairing CLI.
// Reads ~/.astramemory/profiles.json and ~/.astramemory/tokens.<env>.json.
// All writes use atomic rename (write-to-tmp then fs.rename) to avoid
// corrupting existing entries if the process dies mid-write.
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

/**
 * Returns the ~/.astramemory directory path.
 * Respects ASTRAMEMORY_HOME override for tests.
 */
export function astraMemoryDir(): string {
  return process.env['ASTRAMEMORY_HOME'] ?? join(homedir(), '.astramemory');
}

export function profilesFilePath(): string {
  return join(astraMemoryDir(), 'profiles.json');
}

export function tokensFilePath(env: string): string {
  return join(astraMemoryDir(), `tokens.${env}.json`);
}

// ---------------------------------------------------------------------------
// Profile resolution
// ---------------------------------------------------------------------------

interface ProfilesFile {
  [env: string]: { apiUrl?: string };
}

/**
 * Read profiles.json. Returns the parsed object or null if the file is absent.
 */
async function readProfiles(): Promise<ProfilesFile | null> {
  try {
    const raw = await fs.readFile(profilesFilePath(), 'utf8');
    return JSON.parse(raw) as ProfilesFile;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

interface ProfileResolveError extends Error {
  exitCode: number;
}

/**
 * Resolve the API URL for a given env name.
 *
 * @param env  — e.g. "prod", "local", "staging"
 * @returns {{ apiUrl: string, env: string }}
 * @throws  with .exitCode = 4 when profile is missing
 */
export async function resolveProfile(env: string): Promise<{ apiUrl: string; env: string }> {
  const profiles = await readProfiles();
  if (!profiles) {
    const err = new Error(
      `No profiles.json found at ${profilesFilePath()}. ` +
      `Create it with {"${env}":{"apiUrl":"https://..."}} or pass --url <override>.`
    ) as ProfileResolveError;
    err.exitCode = 4;
    throw err;
  }
  const entry = profiles[env];
  if (!entry || !entry.apiUrl) {
    const err = new Error(
      `Profile '${env}' not found in ${profilesFilePath()}. ` +
      `Available: ${Object.keys(profiles).join(', ') || '(none)'}.`
    ) as ProfileResolveError;
    err.exitCode = 4;
    throw err;
  }
  return { apiUrl: entry.apiUrl, env };
}

// ---------------------------------------------------------------------------
// Token resolution
// ---------------------------------------------------------------------------

interface TokenEntry {
  apiKey: string;
  label: string;
  tenantId: string;
  repoPath: string;
  pairedAt: string;
}

interface TokensFile {
  [workspaceId: string]: TokenEntry;
}

/**
 * Read tokens.<env>.json. Returns the parsed object or null when absent.
 */
async function readTokens(env: string): Promise<TokensFile | null> {
  try {
    const raw = await fs.readFile(tokensFilePath(env), 'utf8');
    return JSON.parse(raw) as TokensFile;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

/**
 * Return the apiKey for a given (env, workspaceId) pair, or null if not found.
 */
export async function resolveToken(env: string, workspaceId: string): Promise<string | null> {
  const tokens = await readTokens(env);
  return tokens?.[workspaceId]?.apiKey ?? null;
}

// ---------------------------------------------------------------------------
// Atomic token write
// ---------------------------------------------------------------------------

/**
 * Append / overwrite a single workspaceId entry in tokens.<env>.json.
 * Uses write-to-tmp + rename so existing entries are never lost on crash.
 */
export async function writeToken(env: string, workspaceId: string, entry: TokenEntry): Promise<void> {
  const dir = astraMemoryDir();
  await fs.mkdir(dir, { recursive: true });

  const filePath = tokensFilePath(env);
  const tmpPath = `${filePath}.tmp`;

  // Read existing entries first so we preserve them.
  const existing = (await readTokens(env)) ?? {};
  const next = { ...existing, [workspaceId]: entry };

  await fs.writeFile(tmpPath, JSON.stringify(next, null, 2), { mode: 0o600 });
  await fs.rename(tmpPath, filePath);
}
