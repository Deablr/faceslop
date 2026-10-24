// A public deployment against the real Start app, configured the way README.md's Dokploy section
// says: FACESLOP_PUBLIC_URL (https), APP_PASSWORD, FACESLOP_TRUST_PROXY=1 behind Traefik. Requests
// below carry what Traefik forwards: the public Host, X-Forwarded-Proto https, X-Forwarded-For.
//
// - Host: only the public URL's host and loopback are answered, even though a password is set.
// - HTTPS: every response carries HSTS and the session cookie is Secure (the public URL is https).
// - The rest (CSRF Origin check, the password gate) works through the public host.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/shared/domain';
import { appErrorOf } from '@/shared/errors';
import { errorCodeOf, sessionCookieOf, setCookieOf, startTestApp, type TestApp } from './helpers/faceslop-http';

const PUBLIC_HOST = 'faceslop.example.test';
const PASSWORD = 'a long random app password';
const HSTS = 'max-age=31536000';
const HOST_REFUSED = { code: 'FORBIDDEN', message: "faceslop only answers requests addressed to FACESLOP_PUBLIC_URL's host or localhost." };

/** What Traefik adds to a browser's request. */
const viaProxy: Record<string, string> = {
  host: PUBLIC_HOST,
  'x-forwarded-proto': 'https',
  'x-forwarded-for': '203.0.113.50',
};

let app: TestApp;

beforeAll(async () => {
  app = await startTestApp({
    modules: ['/src/server/functions/app-auth.ts', '/src/server/functions/settings.ts'],
    env: { APP_PASSWORD: PASSWORD, FACESLOP_PUBLIC_URL: `https://${PUBLIC_HOST}`, FACESLOP_TRUST_PROXY: '1' },
    port: 3341,
  });
});

afterAll(async () => {
  await app.close();
  delete process.env.APP_PASSWORD;
  delete process.env.FACESLOP_PUBLIC_URL;
  delete process.env.FACESLOP_TRUST_PROXY;
});

describe('Host check with FACESLOP_PUBLIC_URL', () => {
  it.each([PUBLIC_HOST, `${PUBLIC_HOST}:443`, 'FACESLOP.Example.TEST', '127.0.0.1:{port}', 'localhost', '[::1]:{port}'])(
    'answers %s',
    async (host) => {
      const response = await app.send('/api/health', { headers: { ...viaProxy, host: host.replace('{port}', String(app.port)) } });
      expect(response.status).toBe(200);
    },
  );

  it.each(['192.168.1.20:3000', '10.0.0.5', 'evil.test', `www.${PUBLIC_HOST}`, `${PUBLIC_HOST}.evil.test`])(
    'refuses %s even though a password is set',
    async (host) => {
      const response = await app.send('/api/health', { headers: { ...viaProxy, host } });
      expect(response.status).toBe(403);
      expect(JSON.parse(response.body)).toEqual({ error: HOST_REFUSED });
    },
  );

  it('applies to pages and server functions too', async () => {
    const page = await app.send('/', { headers: { ...viaProxy, host: '192.168.1.20', accept: 'text/html' } });
    expect(page.status).toBe(403);
    expect(errorCodeOf(page)).toBe('FORBIDDEN');
    const { error } = await app.call('getAppAuthStatus', 'GET', undefined, { ...viaProxy, host: '192.168.1.20' });
    expect(appErrorOf(error)).toEqual(HOST_REFUSED);
  });
});

describe('HTTPS', () => {
  it('sends HSTS on pages, /api routes, server functions and refusals', async () => {
    const page = await app.send('/', { headers: { ...viaProxy, accept: 'text/html' } });
    const api = await app.send('/api/health', { headers: viaProxy });
    const fn = (await app.call('getAppAuthStatus', 'GET', undefined, viaProxy)).response;
    const locked = await app.send('/api/remote/stream', { headers: viaProxy });
    const lockedFn = (await app.call('getSettings', 'GET', undefined, viaProxy)).response;
    const wrongHost = await app.send('/api/health', { headers: { ...viaProxy, host: 'evil.test' } });
    expect(page.status).toBe(200);
    expect(locked.status).toBe(401);
    for (const response of [page, api, fn, locked, lockedFn, wrongHost]) {
      expect(response.headers['strict-transport-security']).toBe(HSTS);
      expect(response.headers['x-frame-options']).toBe('DENY');
    }
  });

  it('unlocks through the proxy with a __Host-, Secure, HttpOnly, SameSite=Lax cookie', async () => {
    const browser = app.browser();
    const unlock = await browser.call('appLogin', 'POST', { password: PASSWORD }, { ...viaProxy, origin: `https://${PUBLIC_HOST}` });
    expect(unlock.result).toEqual({ required: true, authenticated: true });
    const setCookie = setCookieOf(unlock.response);
    expect(setCookie).toMatch(/^__Host-faceslop_session=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toMatch(/;\s*Secure/i);
    expect(setCookie).toContain('Path=/');
    expect(setCookie).not.toMatch(/Domain=/i);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toMatch(/SameSite=Lax/i);

    expect((await browser.call('getSettings', 'GET', undefined, viaProxy)).result).toEqual(DEFAULT_SETTINGS);
    const write = await browser.call('updateSettings', 'POST', { sessionNudgeMinutes: 20 }, { ...viaProxy, origin: `https://${PUBLIC_HOST}` });
    expect(write.result).toMatchObject({ sessionNudgeMinutes: 20 });
  });

  it('ignores a plain faceslop_session cookie over HTTPS (it could have been planted by a sibling subdomain)', async () => {
    const victim = app.browser();
    const unlock = await victim.call('appLogin', 'POST', { password: PASSWORD }, { ...viaProxy, origin: `https://${PUBLIC_HOST}` });
    const token = sessionCookieOf(unlock.response).split('=')[1] ?? '';
    expect(token).not.toBe('');
    // The same (valid) token under the plain name is not a session over HTTPS.
    const planted = await app.call('getAppAuthStatus', 'GET', undefined, { ...viaProxy, cookie: `faceslop_session=${token}` });
    expect(planted.result).toEqual({ required: true, authenticated: false });
    const real = await app.call('getAppAuthStatus', 'GET', undefined, { ...viaProxy, cookie: `__Host-faceslop_session=${token}` });
    expect(real.result).toEqual({ required: true, authenticated: true });
  });

  it('still checks Origin against the public Host', async () => {
    const browser = app.browser();
    const crossSite = await browser.call('appLogin', 'POST', { password: PASSWORD }, { ...viaProxy, origin: 'https://evil.test' });
    expect(appErrorOf(crossSite.error)).toEqual({ code: 'FORBIDDEN', message: 'Cross-origin request refused.' });
    expect(setCookieOf(crossSite.response)).toBe('');
    // An explicit default port names the same origin.
    const sameHost = await browser.call('appLogin', 'POST', { password: PASSWORD }, { ...viaProxy, origin: `https://${PUBLIC_HOST}:443` });
    expect(sameHost.result).toEqual({ required: true, authenticated: true });
  });

  it('a locked browser stays locked through the public host', async () => {
    const { error } = await app.call('getSettings', 'GET', undefined, viaProxy);
    expect(appErrorOf(error)?.code).toBe('APP_LOCKED');
  });
});
