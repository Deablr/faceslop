// Request security against the real Start app (port of legacy/test/security.test.ts, no app
// password, no FACESLOP_PUBLIC_URL, no trusted proxy): the DNS-rebinding Host check, CSRF
// (x-faceslop header + Origin), the 256 KB body limit, response headers, and no CORS. Boots the
// project's vite.config.ts (Start + Nitro) like test/server-fn-http.test.ts and talks raw HTTP so
// the Host header can be anything (the helper turns Vite's own host check off). The password gate
// is in test/security-locked-http.test.ts, public deployments in test/security-public-http.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostnameOf, isAllowedHost, isLoopbackHost, originMatchesHost, routePathOf } from '@/server/security/request-guard';
import { appErrorOf } from '@/shared/errors';
import { errorCodeOf, startTestApp, type TestApp } from './helpers/faceslop-http';

let app: TestApp;
let port: number;
const send: TestApp['send'] = (pathname, init) => app.send(pathname, init);
const callServerFn: TestApp['call'] = (name, method, data, headers) => app.call(name, method, data, headers);
const errorCode = errorCodeOf;

beforeAll(async () => {
  app = await startTestApp({
    modules: ['/src/server/functions/settings.ts', '/src/server/functions/hidden.ts', '/src/server/functions/app-auth.ts'],
    env: { APP_PASSWORD: undefined },
    port: 3311,
  });
  port = app.port;
});

afterAll(async () => {
  await app.close();
});

describe('helpers', () => {
  it('parses Host headers', () => {
    expect(hostnameOf('localhost:5173')).toBe('localhost');
    expect(hostnameOf('127.0.0.1')).toBe('127.0.0.1');
    expect(hostnameOf('[::1]:3777')).toBe('::1');
    expect(hostnameOf('LOCALHOST')).toBe('localhost');
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('localhost.evil.test')).toBe(false);
  });

  it('canonicalizes paths the way the router could match them', () => {
    expect(routePathOf('/api/remote/stream')).toBe('/api/remote/stream');
    expect(routePathOf('/API/Remote/Stream/')).toBe('/api/remote/stream');
    expect(routePathOf('/%61pi/remote/stream')).toBe('/api/remote/stream');
    expect(routePathOf('/%2561pi/remote/stream')).toBe('/api/remote/stream');
    expect(routePathOf('//api//remote\\stream')).toBe('/api/remote/stream');
    expect(routePathOf('/api%2Fhealth')).toBe('/api/health');
    expect(routePathOf('/%E0%A4%A/api')).toBe('/%e0%a4%a/api'); // malformed escape left alone
    expect(routePathOf('/')).toBe('/');
    expect(routePathOf('')).toBe('/');
  });

  it('decides which hosts are answered', () => {
    const local = { passwordRequired: false, publicHost: null };
    const lan = { passwordRequired: true, publicHost: null };
    const publicDeployment = { passwordRequired: true, publicHost: 'faceslop.example.com' };
    for (const policy of [local, lan, publicDeployment]) {
      for (const host of ['127.0.0.1', 'localhost', '::1']) expect(isAllowedHost(host, policy)).toBe(true);
    }
    expect(isAllowedHost('192.168.1.20', local)).toBe(false);
    expect(isAllowedHost('192.168.1.20', lan)).toBe(true);
    expect(isAllowedHost('faceslop.example.com', publicDeployment)).toBe(true);
    // With a public URL, the password no longer opens other hosts.
    for (const host of ['192.168.1.20', 'evil.test', 'faceslop.example.com.evil.test', 'www.faceslop.example.com']) {
      expect(isAllowedHost(host, publicDeployment)).toBe(false);
    }
    expect(isAllowedHost('faceslop.example.com', { passwordRequired: false, publicHost: 'faceslop.example.com' })).toBe(true);
  });

  it('compares Origin with Host', () => {
    expect(originMatchesHost('http://localhost:5173', 'localhost:5173')).toBe(true);
    expect(originMatchesHost('http://127.0.0.1:3777', '127.0.0.1:3777')).toBe(true);
    expect(originMatchesHost('http://localhost', 'localhost:80')).toBe(true);
    expect(originMatchesHost('http://evil.test:3777', '127.0.0.1:3777')).toBe(false);
    expect(originMatchesHost('http://localhost:5174', 'localhost:5173')).toBe(false);
    expect(originMatchesHost('null', 'localhost:5173')).toBe(false);
    expect(originMatchesHost('file://', 'localhost:5173')).toBe(false);
  });
});

describe('host check (DNS rebinding)', () => {
  it.each(['127.0.0.1:{port}', 'localhost:{port}', 'localhost', '[::1]:{port}'])('allows loopback host %s', async (host) => {
    const response = await send('/api/health', { headers: { host: host.replace('{port}', String(port)) } });
    expect(response.status).toBe(200);
  });

  it.each(['192.168.1.20:{port}', '10.0.0.5', '[2001:db8::1]:{port}'])('refuses host %s with FORBIDDEN', async (host) => {
    const response = await send('/api/health', { headers: { host: host.replace('{port}', String(port)) } });
    expect(response.status).toBe(403);
    expect(errorCode(response)).toBe('FORBIDDEN');
  });

  it('applies to pages and server functions too', async () => {
    const page = await send('/', { headers: { host: '192.168.1.20' } });
    expect(page.status).toBe(403);
    const { error } = await callServerFn('getSettings', 'GET', undefined, { host: '192.168.1.20' });
    expect(appErrorOf(error)).toEqual({ code: 'FORBIDDEN', message: 'faceslop only answers requests addressed to localhost.' });
  });

  it('refuses foreign host names', async () => {
    for (const host of ['evil.test', 'localhost.evil.test', `evil.test:${String(port)}`]) {
      const response = await send('/api/health', { headers: { host } });
      expect(response.status).toBe(403);
      expect(errorCode(response)).toBe('FORBIDDEN');
    }
  });
});

describe('CSRF', () => {
  it('allows plain GET page and route requests without the header', async () => {
    expect((await send('/api/health')).status).toBe(200);
    expect((await send('/', { headers: { accept: 'text/html' } })).status).toBe(200);
  });

  it('server functions work with the header', async () => {
    const { result } = await callServerFn('getAppAuthStatus', 'GET');
    expect(result).toEqual({ required: false, authenticated: true });
  });

  it('refuses server-function calls without x-faceslop: 1, GET included', async () => {
    for (const value of [null, 'yes']) {
      const post = await callServerFn('hideListing', 'POST', { id: '5', title: 'x' }, { 'x-faceslop': value });
      expect(appErrorOf(post.error)).toEqual({ code: 'FORBIDDEN', message: 'Missing x-faceslop header.' });
      const get = await callServerFn('getSettings', 'GET', undefined, { 'x-faceslop': value });
      expect(appErrorOf(get.error)?.code).toBe('FORBIDDEN');
    }
    const { result } = await callServerFn('listHidden', 'GET');
    expect(result).toEqual([]);
  });

  it('refuses mutating route requests without the header', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await send('/api/health', { method });
      expect(response.status).toBe(403);
      expect(errorCode(response)).toBe('FORBIDDEN');
    }
  });

  it('refuses a mismatched Origin and accepts a matching one', async () => {
    const bad = await callServerFn('hideListing', 'POST', { id: '5', title: 'x' }, { origin: 'http://evil.test' });
    expect(appErrorOf(bad.error)).toEqual({ code: 'FORBIDDEN', message: 'Cross-origin request refused.' });
    const otherPort = await callServerFn('hideListing', 'POST', { id: '5', title: 'x' }, { origin: 'http://127.0.0.1:1' });
    expect(appErrorOf(otherPort.error)?.code).toBe('FORBIDDEN');
    const good = await callServerFn('hideListing', 'POST', { id: '5', title: 'x' }, { origin: `http://127.0.0.1:${String(port)}` });
    expect(good.result).toMatchObject({ id: '5', title: 'x' });
  });

  it('never sends CORS headers', async () => {
    const preflight = await send('/api/health', {
      method: 'OPTIONS',
      headers: { origin: 'http://evil.test', 'access-control-request-method': 'POST' },
    });
    const get = await send('/api/health', { headers: { origin: 'http://evil.test' } });
    const fn = await callServerFn('getSettings', 'GET', undefined, { origin: 'http://evil.test' });
    for (const response of [preflight, get, fn.response]) {
      expect(Object.keys(response.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
    }
  });
});

describe('body size', () => {
  it('refuses bodies over 256 KB', async () => {
    const { error } = await callServerFn('hideListing', 'POST', { id: '1', title: 'x'.repeat(300_000) });
    expect(appErrorOf(error)).toEqual({ code: 'BAD_REQUEST', message: 'Request body is too large.' });
    const route = await send('/api/health', { method: 'POST', headers: { 'x-faceslop': '1' }, body: 'x'.repeat(300_000) });
    expect(route.status).toBe(400);
  });

  it('accepts normal bodies', async () => {
    const { result } = await callServerFn('hideListing', 'POST', { id: '2', title: 'x'.repeat(400) });
    expect(result).toMatchObject({ id: '2' });
  });

  it('refuses streamed (chunked) bodies without a Content-Length', async () => {
    const { error } = await callServerFn('hideListing', 'POST', { id: '3', title: 'x' }, { 'content-length': null });
    expect(appErrorOf(error)?.code).toBe('BAD_REQUEST');
  });
});

describe('response headers', () => {
  it('sets nosniff and frame denial everywhere, no-store on server functions and /api', async () => {
    const page = await send('/', { headers: { accept: 'text/html' } });
    const api = await send('/api/health');
    const fn = (await callServerFn('getSettings', 'GET')).response;
    for (const response of [page, api, fn]) {
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(response.headers['x-frame-options']).toBe('DENY');
      expect(response.headers['referrer-policy']).toBe('no-referrer');
    }
    expect(api.headers['cache-control']).toBe('no-store');
    expect(fn.headers['cache-control']).toBe('no-store');
    expect(page.headers['cache-control']).not.toBe('no-store');
  });

  it('sends no HSTS over plain http, and ignores X-Forwarded-Proto without FACESLOP_TRUST_PROXY', async () => {
    const plain = await send('/api/health');
    const forged = await send('/api/health', { headers: { 'x-forwarded-proto': 'https' } });
    const fn = await callServerFn('getSettings', 'GET', undefined, { 'x-forwarded-proto': 'https' });
    for (const response of [plain, forged, fn.response]) expect(response.headers['strict-transport-security']).toBeUndefined();
  });

  it('refusals carry the same headers', async () => {
    const refused = await send('/api/health', { method: 'POST' });
    expect(refused.headers['x-frame-options']).toBe('DENY');
    expect(refused.headers['cache-control']).toBe('no-store');
    expect(refused.headers['content-type']).toMatch(/application\/json/);

    // Server-function refusals are thrown (Start builds that response), and still carry them.
    const { response, error } = await callServerFn('getSettings', 'GET', undefined, { 'x-faceslop': null });
    expect(appErrorOf(error)?.code).toBe('FORBIDDEN');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cache-control']).toBe('no-store');
  });
});
