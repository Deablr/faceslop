// Static checks of the container setup's security-relevant parts (no Docker needed), and the
// production launcher's start-up rules: the container carries its users' Facebook sessions, so
// compose must publish the port on the host's loopback only, the image must run unprivileged under
// an init process, local state (.data holds the database and fb-sessions/) must never enter the
// build context, and a public deployment (FACESLOP_PUBLIC_URL) must not start without APP_PASSWORD.
//
// The launcher (src/server/node-server.ts) is run with plain Node (type stripping) from a temp dir
// whose package.json maps its Nitro import to a stub that reports "nitro-started" and exits: so a
// run either refuses (exit 1, before Nitro) or gets as far as starting Nitro.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const read = (file: string) => fs.readFileSync(fileURLToPath(new URL(`../${file}`, import.meta.url)), 'utf8');

/** Lines that aren't comments. */
const codeLines = (text: string) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

describe('compose.yaml', () => {
  const compose = read('compose.yaml');

  it('publishes ports on the host loopback only', () => {
    const ports = [...compose.matchAll(/^\s*-\s*"?([^"\n]+:\d+)"?\s*$/gm)]
      .map((match) => match[1] ?? '')
      .filter((entry) => /:\d+$/.test(entry) && !entry.includes('/'));
    expect(ports.length).toBeGreaterThan(0);
    for (const entry of ports) expect(entry).toMatch(/^127\.0\.0\.1:/);
  });

  it('keeps data in a named volume, with shared memory for Chromium and a healthcheck', () => {
    expect(compose).toMatch(/^\s*-\s*faceslop-data:\/app\/\.data\s*$/m);
    expect(compose).toMatch(/^\s*shm_size:\s*1gb\s*$/m);
    expect(compose).toContain('/api/health');
  });

  it('passes the deployment variables through (empty when unset)', () => {
    for (const name of ['APP_PASSWORD', 'FACESLOP_PUBLIC_URL', 'FACESLOP_TRUST_PROXY']) {
      expect(compose).toMatch(new RegExp(`^\\s*${name}:\\s*\\$\\{${name}:-\\}\\s*$`, 'm'));
    }
  });
});

describe('Dockerfile', () => {
  const lines = codeLines(read('Dockerfile'));
  const runtimeStart = lines.findIndex((line) => /^FROM\s+\S+\s+AS\s+runtime$/i.test(line));
  const runtime = lines.slice(runtimeStart);

  it('runs the runtime stage as the unprivileged node user', () => {
    expect(runtimeStart).toBeGreaterThan(-1);
    const user = runtime.findIndex((line) => /^USER\s+node$/.test(line));
    const cmd = runtime.findIndex((line) => line.startsWith('CMD '));
    expect(user).toBeGreaterThan(-1);
    expect(cmd).toBeGreaterThan(user);
  });

  it('declares the container (loopback bind exemption) and uses the production launcher under tini', () => {
    const env = runtime.join('\n');
    expect(env).toMatch(/FACESLOP_DOCKER=1/);
    expect(env).toMatch(/FACESLOP_DATA_DIR=\/app\/\.data/);
    expect(env).toMatch(/apt-get install -y --no-install-recommends tini/);
    // Dokploy (Docker Swarm) adds no init process: the image brings its own.
    expect(runtime).toContain('ENTRYPOINT ["/usr/bin/tini", "-s", "--"]');
    expect(runtime.at(-1)).toBe('CMD ["node", ".output/server/index.mjs"]');
  });

  it('creates the data dir for the node user, mode 0700 (a named volume copies both)', () => {
    expect(runtime).toContain('RUN mkdir -p /app/.data && chown node:node /app/.data && chmod 0700 /app/.data');
  });
});

describe('.dockerignore', () => {
  const ignored = new Set(codeLines(read('.dockerignore')));

  it('keeps local state, secrets and host node_modules out of the build context', () => {
    for (const entry of ['.data', '.env', '.env.*', 'node_modules', '.output', '.git']) expect(ignored).toContain(entry);
  });
});

describe('production launcher (src/server/node-server.ts)', () => {
  let dir: string;

  beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'faceslop-launcher-'));
    fs.copyFileSync(fileURLToPath(new URL('../src/server/node-server.ts', import.meta.url)), path.join(dir, 'node-server.ts'));
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      JSON.stringify({ type: 'module', imports: { '#faceslop/nitro-node-server': './nitro-stub.mjs' } }),
    );
    fs.writeFileSync(
      path.join(dir, 'nitro-stub.mjs'),
      'console.log(`nitro-started ${process.env.NITRO_HOST} ${process.env.NODE_ENV}`);\nprocess.exit(0);\n',
    );
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Run the launcher with exactly `env` (plus PATH). */
  const launch = (env: Readonly<Record<string, string>>) => {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', 'node-server.ts'], {
      cwd: dir,
      env: { PATH: process.env.PATH ?? '', ...env },
      encoding: 'utf8',
      timeout: 20_000,
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };

  const started = (run: ReturnType<typeof launch>) => run.status === 0 && run.stdout.includes('nitro-started');

  it('starts on loopback by default, in production mode', () => {
    const run = launch({});
    expect(started(run)).toBe(true);
    expect(run.stdout).toContain('nitro-started 127.0.0.1 production');
    expect(run.stderr).toBe('');
  });

  it('refuses a non-loopback HOST without APP_PASSWORD, unless in Docker', () => {
    const refused = launch({ HOST: '0.0.0.0' });
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('Refusing to listen on 0.0.0.0');
    expect(started(launch({ HOST: '0.0.0.0', APP_PASSWORD: 'a long random app password' }))).toBe(true);
    expect(started(launch({ HOST: '0.0.0.0', FACESLOP_DOCKER: '1' }))).toBe(true);
  });

  it.each<Readonly<Record<string, string>>>([
    { HOST: '0.0.0.0', FACESLOP_DOCKER: '1' },
    { HOST: '0.0.0.0' },
    {},
    { APP_PASSWORD: '' },
  ])('refuses FACESLOP_PUBLIC_URL without APP_PASSWORD (%o)', (env) => {
    const run = launch({ ...env, FACESLOP_PUBLIC_URL: 'https://faceslop.example.com' });
    expect(run.status).toBe(1);
    expect(run.stdout).not.toContain('nitro-started');
    expect(run.stderr).toContain('Refusing to start: FACESLOP_PUBLIC_URL is set (https://faceslop.example.com)');
    expect(run.stderr).toContain('APP_PASSWORD');
  });

  it('refuses a FACESLOP_PUBLIC_URL that is not an http(s) URL', () => {
    for (const publicUrl of ['faceslop.example.com', 'ftp://faceslop.example.com']) {
      const run = launch({ FACESLOP_PUBLIC_URL: publicUrl, APP_PASSWORD: 'a long random app password' });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain('FACESLOP_PUBLIC_URL must be an http(s) URL');
    }
  });

  it('starts a public deployment configured like Dokploy, without warnings', () => {
    const run = launch({
      HOST: '0.0.0.0',
      FACESLOP_DOCKER: '1',
      FACESLOP_PUBLIC_URL: 'https://faceslop.example.com',
      FACESLOP_TRUST_PROXY: '1',
      APP_PASSWORD: 'a long random app password',
    });
    expect(started(run)).toBe(true);
    expect(run.stdout).toContain('nitro-started 0.0.0.0');
    expect(run.stderr).toBe('');
  });

  it('warns (but starts) without FACESLOP_TRUST_PROXY, over plain http, and with a short password', () => {
    const run = launch({ HOST: '0.0.0.0', FACESLOP_DOCKER: '1', FACESLOP_PUBLIC_URL: 'http://faceslop.example.com', APP_PASSWORD: 'hunter2' });
    expect(started(run)).toBe(true);
    expect(run.stderr).toContain('FACESLOP_TRUST_PROXY is not');
    expect(run.stderr).toContain('FACESLOP_PUBLIC_URL is not https');
    expect(run.stderr).toContain('APP_PASSWORD is shorter than 12 characters');
  });

  it('does not warn about a short password on loopback', () => {
    const run = launch({ APP_PASSWORD: 'hunter2' });
    expect(started(run)).toBe(true);
    expect(run.stderr).toBe('');
  });
});
