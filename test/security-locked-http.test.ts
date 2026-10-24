// The APP_PASSWORD gate against the real Start app (port of the "app password" part of
// legacy/test/security.test.ts, on the Sessions model): server functions and /api/* routes are
// locked (APP_LOCKED) until this browser enters the password; app-auth functions, /api/health and
// pages stay reachable; unlocking sets the faceslop_session cookie (HttpOnly, SameSite=Lax,
// Path=/, ~400 days) and never expires; locking keeps the session and its data; wrong passwords
// are throttled per client address; any Host is accepted (no FACESLOP_PUBLIC_URL: the password
// protects everything instead).
//
// FACESLOP_TRUST_PROXY=1 here, as behind a reverse proxy: X-Forwarded-Proto https makes the cookie
// Secure and adds HSTS, and the throttle keys on X-Forwarded-For's last hop.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/shared/domain';
import { INTERNAL_MESSAGE, appErrorOf } from '@/shared/errors';
import { sessionCookieOf, setCookieOf, startTestApp, type TestApp, type TestClient } from './helpers/faceslop-http';

const PASSWORD = 'correct horse battery staple';
const COOKIE = 'faceslop_session';
const LOCKED = { code: 'APP_LOCKED', message: 'Enter the faceslop app password.' };
const MAX_AGE_400_DAYS = 400 * 24 * 60 * 60;

let app: TestApp;
const send: TestApp['send'] = (pathname, init) => app.send(pathname, init);
const callServerFn: TestApp['call'] = (name, method, data, headers) => app.call(name, method, data, headers);

const login = (password: string, headers: Record<string, string | null> = {}, client: TestClient = app) =>
  client.call('appLogin', 'POST', { password }, headers);

beforeAll(async () => {
  app = await startTestApp({
    modules: ['/src/server/functions/app-auth.ts', '/src/server/functions/settings.ts'],
    env: { APP_PASSWORD: PASSWORD, FACESLOP_PUBLIC_URL: undefined, FACESLOP_TRUST_PROXY: '1' },
    port: 3321,
  });
});

afterAll(async () => {
  await app.close();
  delete process.env.APP_PASSWORD;
  delete process.env.FACESLOP_TRUST_PROXY;
});

describe('app password', () => {
  it('locks server functions and /api routes, but not app-auth, /api/health, or pages', async () => {
    const locked = await callServerFn('getSettings', 'GET');
    expect(appErrorOf(locked.error)).toEqual(LOCKED);
    const lockedWrite = await callServerFn('updateSettings', 'POST', { sessionNudgeMinutes: 5 });
    expect(appErrorOf(lockedWrite.error)?.code).toBe('APP_LOCKED');
    // A locked write creates no session.
    expect(setCookieOf(lockedWrite.response)).toBe('');

    const route = await send('/api/remote/stream');
    expect(route.status).toBe(401);
    expect(JSON.parse(route.body)).toEqual({ error: LOCKED });
    expect((await send('/api/health')).status).toBe(200);

    expect((await callServerFn('getAppAuthStatus', 'GET')).result).toEqual({ required: true, authenticated: false });
    expect((await callServerFn('appLogout', 'POST')).result).toEqual({ required: true, authenticated: false });
  });

  it('still renders pages (the UI shows its lock screen); SSR server-function calls get APP_LOCKED, not a crash', async () => {
    const page = await send('/', { headers: { accept: 'text/html' } });
    expect(page.status).toBe(200);
    expect(page.body).toContain('<html');
    expect(page.body).not.toContain(INTERNAL_MESSAGE);
    expect(setCookieOf(page)).toBe('');
    // The home page prefetches server functions during SSR and shows their error codes.
    for (const [, code] of page.body.matchAll(/data-testid="error-code"[^>]*>([A-Z_]+)</g)) expect(code).toBe('APP_LOCKED');
  });

  // The router matches file routes case-insensitively and percent-decodes the path, so each of
  // these reaches the SSE stream route. Before the gate used the canonical path, they streamed the
  // remote view to anyone on the network.
  it.each([
    '/API/remote/stream',
    '/Api/Remote/Stream',
    '/%61pi/remote/stream',
    '/%2561pi/remote/stream',
    '/api%2Fremote%2Fstream',
    '/api/remote/stream/',
    '/api\\remote/stream',
  ])('locks the stream route however its path is spelled: %s', async (pathname) => {
    const response = await send(pathname, { headers: { accept: 'text/event-stream' } });
    expect(response.status).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: LOCKED });
  });

  it('keeps /api/health open however its path is spelled', async () => {
    for (const pathname of ['/API/HEALTH', '/api/health/']) expect((await send(pathname)).status).toBe(200);
  });

  it('accepts any Host without FACESLOP_PUBLIC_URL (the password gate applies instead)', async () => {
    expect((await send('/api/health', { headers: { host: '192.168.1.20:3000' } })).status).toBe(200);
    expect((await send('/api/health', { headers: { host: 'faceslop.lan' } })).status).toBe(200);
    const locked = await send('/api/remote/stream', { headers: { host: '192.168.1.20:3000' } });
    expect(locked.status).toBe(401);
  });

  it('rejects wrong passwords and forged cookies', async () => {
    const wrong = await login('hunter3');
    expect(appErrorOf(wrong.error)?.code).toBe('FORBIDDEN');
    expect(setCookieOf(wrong.response)).toBe('');
    const forged = await callServerFn('getSettings', 'GET', undefined, { cookie: `${COOKIE}=forged` });
    expect(appErrorOf(forged.error)?.code).toBe('APP_LOCKED');
    expect((await send('/api/remote/stream', { headers: { cookie: `${COOKIE}=forged` } })).status).toBe(401);
  });

  it('requires the CSRF header for login', async () => {
    const response = await login(PASSWORD, { 'x-faceslop': null });
    expect(appErrorOf(response.error)?.code).toBe('FORBIDDEN');
    expect(setCookieOf(response.response)).toBe('');
  });

  it('unlocks with a long-lived HttpOnly SameSite=Lax cookie, and locks again without losing the session', async () => {
    const browser = app.browser();
    const response = await login(PASSWORD, {}, browser);
    expect(response.result).toEqual({ required: true, authenticated: true });
    const setCookie = setCookieOf(response.response);
    expect(setCookie).toMatch(new RegExp(`^${COOKIE}=[A-Za-z0-9_-]{43};`));
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain(`Max-Age=${String(MAX_AGE_400_DAYS)}`);
    expect(setCookie).not.toMatch(/;\s*Secure/i); // plain http, no X-Forwarded-Proto
    expect(response.response.headers['strict-transport-security']).toBeUndefined();

    expect((await browser.call('getSettings', 'GET')).result).toEqual(DEFAULT_SETTINGS);
    expect((await browser.call('getAppAuthStatus', 'GET')).result).toEqual({ required: true, authenticated: true });
    // The gate lets an unlocked session through to the route itself (which then 404s: no such route).
    expect((await browser.send('/api/nope')).status).not.toBe(401);
    // Reads never re-issue the cookie.
    expect(setCookieOf((await browser.call('getSettings', 'GET')).response)).toBe('');

    const saved = await browser.call('updateSettings', 'POST', { sessionNudgeMinutes: 45 });
    expect(saved.result).toMatchObject({ sessionNudgeMinutes: 45 });
    // Another browser (no cookie) is still locked.
    expect(appErrorOf((await callServerFn('getSettings', 'GET')).error)).toEqual(LOCKED);

    const out = await browser.call('appLogout', 'POST');
    expect(out.result).toEqual({ required: true, authenticated: false });
    expect(appErrorOf((await browser.call('getSettings', 'GET')).error)).toEqual(LOCKED);
    expect((await browser.send('/api/remote/stream')).status).toBe(401);
    expect((await browser.call('getAppAuthStatus', 'GET')).result).toEqual({ required: true, authenticated: false });

    // Unlocking again (the same browser) gets the same session back, data included.
    const again = await login(PASSWORD, {}, browser);
    expect(again.result).toEqual({ required: true, authenticated: true });
    expect(sessionCookieOf(again.response)).not.toBe('');
    expect((await browser.call('getSettings', 'GET')).result).toMatchObject({ sessionNudgeMinutes: 45 });
  });

  it('marks the cookie Secure and sends HSTS when the trusted proxy says the browser used HTTPS', async () => {
    const https = { 'x-forwarded-proto': 'https' };
    const response = await login(PASSWORD, https);
    expect(response.result).toEqual({ required: true, authenticated: true });
    expect(setCookieOf(response.response)).toMatch(/^__Host-faceslop_session=[^;]+;.*;\s*Secure/i);
    expect(response.response.headers['strict-transport-security']).toBe('max-age=31536000');

    for (const pathname of ['/api/health', '/']) {
      const viaProxy = await send(pathname, { headers: { ...https, accept: 'text/html' } });
      expect(viaProxy.headers['strict-transport-security']).toBe('max-age=31536000');
      const plain = await send(pathname, { headers: { 'x-forwarded-proto': 'http', accept: 'text/html' } });
      expect(plain.headers['strict-transport-security']).toBeUndefined();
    }
    // Refusals too.
    const refused = await send('/api/remote/stream', { headers: https });
    expect(refused.status).toBe(401);
    expect(refused.headers['strict-transport-security']).toBe('max-age=31536000');
  });

  // Last: it leaves this address throttled for a minute.
  it("throttles 5 wrong passwords a minute per client address (the trusted proxy's last X-Forwarded-For hop)", async () => {
    // A client can prepend anything to X-Forwarded-For; only the hop the proxy added counts.
    const attacker = { 'x-forwarded-for': '198.51.100.9, 203.0.113.7' };
    for (let i = 0; i < 5; i++) {
      const wrong = await login(`wrong${String(i)}`, attacker);
      expect(appErrorOf(wrong.error)?.code).toBe('FORBIDDEN');
    }
    const throttled = await login(PASSWORD, { 'x-forwarded-for': '192.0.2.1, 203.0.113.7' });
    expect(appErrorOf(throttled.error)?.code).toBe('FORBIDDEN');
    expect(setCookieOf(throttled.response)).toBe('');

    // Someone else, behind the same proxy, can still get in.
    const other = await login(PASSWORD, { 'x-forwarded-for': '198.51.100.9' });
    expect(other.result).toEqual({ required: true, authenticated: true });
  });
});
