// Boot the real app (the project's vite.config.ts: Start + Nitro + React) for a test file and
// talk raw HTTP to it, so any header (Host included) can be sent. Server functions are called the
// way Start's client fetcher calls them, and their responses are decoded with the browser's Seroval
// plugins. OWNER: security builder (used by test/security*-http.test.ts, test/functions-http.test.ts
// and test/server-fn-http.test.ts).
//
// `app.send` / `app.call` send no cookies unless given one: each call is a new, cookie-less
// browser. `app.browser()` is one browser with its own cookie jar (it keeps the (__Host-)faceslop_session
// cookie the server sets and sends it back), so its local data persists across calls.
//
// Vite's own dev-server host check is off (allowedHosts: true), so every Host header reaches
// faceslop's request guard, which is what the tests are about.
//
// Each test file runs in its own worker process, so the environment set here (data dir, checker
// off, APP_PASSWORD, FACESLOP_PUBLIC_URL, ...) only affects that file's server.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';
import { decodeResponse, encodePayload } from './client-serialization';

export interface RawResponse {
  readonly status: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: string;
}

export interface RequestInit {
  readonly method?: string;
  /** null removes a default header. */
  readonly headers?: Readonly<Record<string, string | null>>;
  readonly body?: string;
}

export interface ServerFnResponse {
  readonly response: RawResponse;
  readonly result?: unknown;
  readonly error?: unknown;
}

/** Something that sends requests: the app itself (no cookies) or one browser (a cookie jar). */
export interface TestClient {
  /** A raw request. Defaults: Host 127.0.0.1:<port>; a string body gets a Content-Length, like fetch. */
  readonly send: (pathname: string, init?: RequestInit) => Promise<RawResponse>;
  /** Call a server function by export name (its module must be in `modules`). */
  readonly call: (
    name: string,
    method: 'GET' | 'POST',
    data?: unknown,
    headers?: Readonly<Record<string, string | null>>,
  ) => Promise<ServerFnResponse>;
}

/** One browser: keeps the cookies the server sets (an explicit `cookie` header overrides the jar). */
export interface TestBrowser extends TestClient {
  /** The Cookie header this browser sends ('' when it has no cookies). */
  readonly cookieHeader: () => string;
}

export interface TestApp extends TestClient {
  readonly port: number;
  /** A new browser with an empty cookie jar. */
  readonly browser: () => TestBrowser;
  readonly close: () => Promise<void>;
}

const root = fileURLToPath(new URL('../..', import.meta.url));

const withoutNulls = (headers: Readonly<Record<string, string | null>>): Record<string, string> =>
  Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null));

/**
 * Start a dev server with a fresh data dir and the background checker off. `env` is applied first
 * (undefined deletes a variable). `modules` are the server-function files to discover ids from.
 */
export async function startTestApp(options: {
  readonly modules: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly port?: number;
}): Promise<TestApp> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'faceslop-http-'));
  process.env.FACESLOP_DATA_DIR = dataDir;
  process.env.FACESLOP_DISABLE_CHECKER = '1';
  for (const [key, value] of Object.entries(options.env ?? {})) {
    // process.env stringifies assignments, so unset with Reflect.deleteProperty.
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  }

  const server: ViteDevServer = await createServer({
    root,
    configFile: path.join(root, 'vite.config.ts'),
    logLevel: 'silent',
    server: { port: options.port ?? 3311, strictPort: false, allowedHosts: true },
  });
  await server.listen();
  const address = server.httpServer?.address();
  if (address === null || address === undefined || typeof address === 'string') throw new Error('dev server has no port');
  const port = address.port;

  const send = (pathname: string, init: RequestInit = {}): Promise<RawResponse> => {
    const headers = withoutNulls({
      host: `127.0.0.1:${String(port)}`,
      ...(init.body === undefined ? {} : { 'content-length': String(Buffer.byteLength(init.body)) }),
      ...init.headers,
    });
    return new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port, path: pathname, method: init.method ?? 'GET', headers }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') });
        });
      });
      request.on('error', reject);
      if (init.body !== undefined) request.write(init.body);
      request.end();
    });
  };

  const functionIds = new Map<string, string>();
  for (const module of options.modules) {
    const code = (await send(module)).body;
    for (const [, id] of code.matchAll(/createClientRpc\("([^"]+)"\)/g)) {
      if (id === undefined) continue;
      const meta = JSON.parse(Buffer.from(id, 'base64url').toString('utf8')) as { export: string };
      functionIds.set(meta.export.replace(/_createServerFn_handler$/, ''), id);
    }
  }

  /** Server-function calls through `sendWith` (the app's own `send`, or a browser's). */
  const callerOf =
    (sendWith: TestClient['send']): TestClient['call'] =>
    async (name, method, data, headers = {}) => {
      const id = functionIds.get(name);
      if (id === undefined) throw new Error(`unknown server function ${name}`);
      const payload = data === undefined ? undefined : await encodePayload(data);
      let pathname = `/_serverFn/${id}`;
      if (method === 'GET' && payload !== undefined) pathname += `?payload=${encodeURIComponent(payload)}`;
      const hasBody = method === 'POST' && payload !== undefined;
      const response = await sendWith(pathname, {
        method,
        headers: {
          'x-tsr-serverfn': 'true',
          'x-faceslop': '1',
          accept: 'application/x-tss-framed, application/x-ndjson, application/json',
          // Start's client only sets a content type when there is a body.
          ...(hasBody ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        ...(hasBody ? { body: payload } : {}),
      });
      if (response.headers['x-tss-serialized'] !== 'true') return { response };
      return { response, ...(decodeResponse(JSON.parse(response.body)) as { result?: unknown; error?: unknown }) };
    };

  const browser = (): TestBrowser => {
    const jar = new Map<string, string>();
    const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    const browserSend: TestClient['send'] = async (pathname, init = {}) => {
      const cookie = cookieHeader();
      const headers = { ...(cookie === '' ? {} : { cookie }), ...init.headers };
      const response = await send(pathname, { ...init, headers });
      for (const setCookie of setCookiesOf(response)) {
        const [pair = ''] = setCookie.split(';');
        const eq = pair.indexOf('=');
        if (eq === -1) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        if (value === '' || /;\s*max-age=0\s*(;|$)/i.test(setCookie)) jar.delete(name);
        else jar.set(name, value);
      }
      return response;
    };
    return { send: browserSend, call: callerOf(browserSend), cookieHeader };
  };

  return {
    port,
    send,
    call: callerOf(send),
    browser,
    close: async () => {
      await server.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** The `{ error: { code } }` of a JSON error response. */
export const errorCodeOf = (response: RawResponse): string =>
  (JSON.parse(response.body) as { error: { code: string } }).error.code;

/** Every Set-Cookie header of a response. */
export const setCookiesOf = (response: RawResponse): readonly string[] => response.headers['set-cookie'] ?? [];

/** All Set-Cookie headers, newline-joined ('' when none). */
export const setCookieOf = (response: RawResponse): string => setCookiesOf(response).join('\n');

/**
 * "faceslop_session=<token>" (or "__Host-faceslop_session=<token>" over HTTPS) from a response's
 * Set-Cookie ('' when it sets none), for a Cookie header.
 */
export const sessionCookieOf = (response: RawResponse): string =>
  setCookiesOf(response)
    .map((header) => header.split(';')[0] ?? '')
    .find((pair) => pair.startsWith('faceslop_session=') || pair.startsWith('__Host-faceslop_session=')) ?? '';
