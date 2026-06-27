// Cross-platform auth.json reader/writer for the memory CLI.
// Location:
//   POSIX:   $XDG_CONFIG_HOME/memory/auth.json   (default ~/.config/memory/auth.json)
//   Windows: %APPDATA%/memory/auth.json
import { promises as fs } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';

export interface AuthData {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_at?: number;
  authority?: string;
  client_id?: string;
}

export function authFilePath(): string {
  if (platform() === 'win32') {
    const appdata = process.env['APPDATA'] || join(homedir(), 'AppData', 'Roaming');
    return join(appdata, 'memory', 'auth.json');
  }
  const xdg = process.env['XDG_CONFIG_HOME'] || join(homedir(), '.config');
  return join(xdg, 'memory', 'auth.json');
}

export async function readAuth(): Promise<AuthData | null> {
  try {
    const raw = await fs.readFile(authFilePath(), 'utf8');
    return JSON.parse(raw) as AuthData;
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

export async function writeAuth(data: AuthData): Promise<void> {
  const p = authFilePath();
  await fs.mkdir(dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(data, null, 2), { mode: 0o600 });
}
