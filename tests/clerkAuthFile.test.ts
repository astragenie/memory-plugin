import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';

describe('clerkAuthFile', () => {
  it('authFilePath — POSIX branch via mocked XDG_CONFIG_HOME', async () => {
    const savedXdg = process.env['XDG_CONFIG_HOME'];
    process.env['XDG_CONFIG_HOME'] = '/tmp/test-xdg-home';

    // Dynamic import to get a fresh module evaluation under vitest
    const { authFilePath } = await import('../lib/clerkAuthFile.ts');
    const p = authFilePath();

    // Either Windows (APPDATA) or POSIX (XDG) path — must end in memory/auth.json
    expect(
      p.endsWith('memory/auth.json') || p.endsWith('memory\\auth.json')
    ).toBe(true);
    expect(p).toContain('memory');

    if (savedXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = savedXdg;
  });

  it('authFilePath — Windows path constructed correctly from APPDATA env', () => {
    const appdata = 'C:\\Users\\TestUser\\AppData\\Roaming';
    const expected = join(appdata, 'memory', 'auth.json');
    expect(expected).toContain('memory');
    expect(expected.endsWith('auth.json')).toBe(true);
    expect(expected).toMatch(/AppData.Roaming/);
  });

  it('readAuth — returns null cleanly when auth.json is missing', async () => {
    const savedXdg = process.env['XDG_CONFIG_HOME'];
    const savedAppdata = process.env['APPDATA'];
    process.env['XDG_CONFIG_HOME'] = '/tmp/memory-no-such-dir-' + Date.now();
    delete process.env['APPDATA'];

    const { readAuth } = await import('../lib/clerkAuthFile.ts');
    const result = await readAuth();
    expect(result).toBeNull();

    if (savedXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = savedXdg;
    if (savedAppdata !== undefined) process.env['APPDATA'] = savedAppdata;
  });
});
