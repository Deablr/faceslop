// Security hooks called by the global middleware in src/start.ts. OWNER: security builder.
// Port of legacy/src/server/security.ts `securityMiddleware` (plus legacy's 256 KB bodyLimit),
// extended for public deployments (FACESLOP_PUBLIC_URL behind a reverse proxy).
//
// Two hooks (guardRequest, which also hands back the response-header step, and guardServerFn),
// because Start gives each middleware kind different information (verified against
// @tanstack/react-start 1.169, dev and production builds):
// - Request middleware sees every HTTP request (pages, /_serverFn/* calls, /api/* server routes)
//   but NOT which server function is being called: production server-function URLs are opaque
//   hashes, and `serverFnMeta` is never passed to request middleware.
// - Function middleware sees `serverFnMeta` ({ id, name, filename }) for every server-function
//   call, including the in-process calls loaders make during SSR (which never pass through
//   request middleware). So the APP_PASSWORD gate for server functions lives there.
//
// How to refuse:
// - guardRequest: return a JSON Response (`ApiErrorBody`, status `httpStatusOf[code]`) for
//   'router' requests; THROW an AppError for 'serverFn' requests (the client then decodes it with
//   its code; a returned Response cannot be decoded by the client).
// - guardServerFn: throw an AppError (APP_LOCKED). It reaches the client, and SSR, with its code.
//
// What is checked:
// 1. DNS rebinding: the Host header (hostname, any port) must be loopback (127.0.0.1, localhost,
//    [::1]) or FACESLOP_PUBLIC_URL's host. Without FACESLOP_PUBLIC_URL, an APP_PASSWORD lifts the
//    rule (LAN use: the password gate protects everything instead); with it, the rule always
//    applies.
// 2. CSRF: requests other than GET/HEAD need `x-faceslop: 1` (a cross-site page cannot send a
//    custom header without a CORS preflight, which faceslop never grants) and, when an Origin
//    header is present, an Origin matching Host. Server-function calls need the header even for
//    GET: a cross-site <img src="/_serverFn/..."> must not make faceslop talk to Facebook.
// 3. Bodies over 256 KB are refused (Content-Length; chunked bodies without one are refused too).
// 4. APP_PASSWORD gate: a request passes when no password is set or when its `faceslop_session`
//    cookie names an unlocked session (Sessions.resolve; unlocking never expires). /api/* server
//    routes except /api/health are gated here (APP_LOCKED). "/api/*" is decided on the canonical
//    path (routePathOf): the router matches case-insensitively and percent-decodes, so
//    "/API/remote/stream" and "/%61pi/remote/stream" reach the stream route and must be gated
//    like it. Server functions are gated in guardServerFn, except app-auth.ts's. Pages always
//    render, so the UI can show its lock screen (its loaders get APP_LOCKED).
//
// Response headers: nosniff, X-Frame-Options DENY, Referrer-Policy no-referrer everywhere;
// no-store on server functions and /api/*; HSTS when the browser reached faceslop over HTTPS
// (CurrentClient.secure: FACESLOP_PUBLIC_URL is https, or FACESLOP_TRUST_PROXY=1 and the proxy
// says X-Forwarded-Proto: https), the same condition that makes the session cookie Secure.
//
// Request data is read with the explicit `request` (guardRequest) or by the bridge before the
// Effect runs (guardServerFn), never with request helpers from inside an Effect.
import '@tanstack/react-start/server-only';
import { setResponseHeaders } from '@tanstack/react-start/server';
import { Effect, Option } from 'effect';
import { readRequestInfo, runEffect } from '@/server/bridge';
import { AppConfig } from '@/server/config';
import { currentSession, makeCurrentClient } from '@/server/session/CurrentClient';
import { Sessions } from '@/server/session/Sessions';
import { AppError, httpStatusOf, type ApiErrorBody } from '@/shared/errors';

export interface GuardInput {
  readonly request: Request;
  /** 'serverFn' for /_serverFn/* calls, 'router' for pages and server routes (/api/*). */
  readonly handlerType: 'serverFn' | 'router';
}

/** What guardRequest decided. */
export interface GuardedRequest {
  /** A refused 'router' request's answer (JSON ApiErrorBody); undefined when the request may go on. */
  readonly refusal: Response | undefined;
  /** Add the security headers (see the file header); rebuilds responses with immutable headers. */
  readonly secureResponse: (response: Response) => Response;
}

/** Header every server-function call carries (added by the client middleware in src/start.ts). */
const CSRF_HEADER = 'x-faceslop';
export const MAX_BODY_BYTES = 256 * 1024;
const SAFE_METHODS = new Set(['GET', 'HEAD']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
/** /api routes reachable without the app password. */
const OPEN_API_PATHS = new Set(['/api/health']);
/** Server functions reachable without the app password (so the UI can show the password screen). */
const OPEN_SERVER_FN_FILE = 'src/server/functions/app-auth.ts';
/** One year. No includeSubDomains: other services may live on sibling subdomains. */
export const HSTS_VALUE = 'max-age=31536000';

const LOCKED_MESSAGE = 'Enter the faceslop app password.';

// ---------- pure helpers (exported for tests) ----------

/** Hostname from a Host header value: "localhost:5173" -> "localhost", "[::1]:3000" -> "::1". */
export function hostnameOf(hostHeader: string): string {
  const host = hostHeader.trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return host.slice(1, end === -1 ? undefined : end);
  }
  const colon = host.indexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

export const isLoopbackHost = (hostname: string): boolean => LOOPBACK_HOSTS.has(hostname);

/** Which hosts faceslop answers, from the configuration. */
export interface HostPolicy {
  readonly passwordRequired: boolean;
  /** FACESLOP_PUBLIC_URL's hostname (as hostnameOf returns it), or null. */
  readonly publicHost: string | null;
}

/**
 * The DNS-rebinding rule for a Host header's hostname: loopback always; FACESLOP_PUBLIC_URL's
 * host when it is set (and nothing else, password or not); without it, any host once a password
 * is set.
 */
export function isAllowedHost(hostname: string, policy: HostPolicy): boolean {
  if (isLoopbackHost(hostname)) return true;
  if (policy.publicHost !== null) return hostname === policy.publicHost;
  return policy.passwordRequired;
}

/** Does an Origin header ("http://localhost:3000") name the same host:port as the Host header? */
export function originMatchesHost(origin: string, hostHeader: string): boolean {
  if (!URL.canParse(origin)) return false; // includes "Origin: null"
  const parsedOrigin = new URL(origin);
  if (parsedOrigin.protocol !== 'http:' && parsedOrigin.protocol !== 'https:') return false;
  const hostUrl = `${parsedOrigin.protocol}//${hostHeader.trim()}`;
  if (!URL.canParse(hostUrl)) return false;
  return parsedOrigin.host === new URL(hostUrl).host;
}

/** Percent-decode every escape that decodes (repeatedly, so double-encoding can't hide a path). */
function decodePercentEscapes(path: string): string {
  let current = path;
  for (let round = 0; round < 3; round++) {
    const next = current.replaceAll(/(?:%[0-9a-f]{2})+/gi, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run; // malformed UTF-8: leave that run as it is
      }
    });
    if (next === current) break;
    current = next;
  }
  return current;
}

/**
 * The path the way the router could match it, for deciding which rules apply: percent-decoded,
 * lowercased (file routes match case-insensitively: "/API/remote/stream" IS the stream route),
 * backslashes as slashes, repeated and trailing slashes collapsed. It decodes at least as much as
 * the router does, so a path can only gain rules here, never escape them.
 */
export function routePathOf(pathname: string): string {
  const canonical = decodePercentEscapes(pathname)
    .replaceAll('\\', '/')
    .replace(/\/{2,}/g, '/')
    .toLowerCase()
    .replace(/\/+$/, '');
  return canonical === '' ? '/' : canonical;
}

/** Is this (canonical) path an /api server route? */
const isApiPath = (routePath: string) => routePath === '/api' || routePath.startsWith('/api/');

/** `src/server/functions/app-auth.ts`, however the compiler spelled the path. */
const isOpenServerFn = (filename: string) => {
  const normalized = filename.replaceAll('\\', '/');
  return normalized === OPEN_SERVER_FN_FILE || normalized.endsWith(`/${OPEN_SERVER_FN_FILE}`);
};

const BASE_HEADERS: Readonly<Record<string, string>> = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  // Listing photos load from Facebook's CDN: don't tell it which page asked.
  'referrer-policy': 'no-referrer',
};

/** The security headers for a request (see the file header); `https`: CurrentClient.secure. */
function securityHeadersFor(input: GuardInput, https: boolean): Record<string, string> {
  const headers: Record<string, string> = { ...BASE_HEADERS };
  if (https) headers['strict-transport-security'] = HSTS_VALUE;
  if (input.handlerType === 'serverFn' || isApiPath(routePathOf(new URL(input.request.url).pathname))) {
    headers['cache-control'] = 'no-store';
  }
  return headers;
}

/** Set `headers` on a response (a copy when its headers are immutable, e.g. Response.redirect). */
function withHeaders(response: Response, headers: Readonly<Record<string, string>>): Response {
  const apply = (target: Response) => {
    for (const [name, value] of Object.entries(headers)) target.headers.set(name, value);
    return target;
  };
  try {
    return apply(response);
  } catch {
    // Immutable headers: copy the response (same body stream, status and headers).
    return apply(new Response(response.body, response));
  }
}

/**
 * A response that may not have passed `secureResponse` (see src/server.ts): add the security
 * headers unless the guard already did (it always sets x-content-type-options).
 */
export async function finishUnguarded(response: Response, request: Request): Promise<Response> {
  if (response.headers.has('x-content-type-options')) return response;
  const input: GuardInput = { request, handlerType: 'router' };
  const https = await runEffect(
    Effect.map(makeCurrentClient(readRequestInfo(request), () => undefined), (client) => client.secure),
  ).catch(() => false);
  return withHeaders(response, securityHeadersFor(input, https));
}

// ---------- the checks ----------

/** The first rule the request breaks (or null), and the response headers it gets either way. */
const inspect = (input: GuardInput) =>
  Effect.gen(function* () {
    const { request, handlerType } = input;
    const config = yield* AppConfig;
    const sessions = yield* Sessions;
    // This request's cookie and transport, read from `request` itself. No cookie is ever set here.
    const client = yield* makeCurrentClient(readRequestInfo(request), () => undefined);
    const headers = securityHeadersFor(input, client.secure);
    const refuse = (code: AppError['code'], message: string) => ({ headers, refusal: new AppError({ code, message }) });

    const url = new URL(request.url);
    const hostHeader = request.headers.get('host') ?? url.host;
    const policy: HostPolicy = {
      passwordRequired: sessions.passwordRequired,
      publicHost: Option.getOrNull(Option.map(config.publicUrl, (publicUrl) => hostnameOf(publicUrl.host))),
    };
    if (!isAllowedHost(hostnameOf(hostHeader), policy)) {
      return refuse(
        'FORBIDDEN',
        policy.publicHost === null
          ? 'faceslop only answers requests addressed to localhost.'
          : "faceslop only answers requests addressed to FACESLOP_PUBLIC_URL's host or localhost.",
      );
    }

    const safeMethod = SAFE_METHODS.has(request.method.toUpperCase());
    if (!safeMethod || handlerType === 'serverFn') {
      if (request.headers.get(CSRF_HEADER) !== '1') return refuse('FORBIDDEN', `Missing ${CSRF_HEADER} header.`);
      const origin = request.headers.get('origin');
      if (origin !== null && !originMatchesHost(origin, hostHeader)) return refuse('FORBIDDEN', 'Cross-origin request refused.');
    }

    if (!safeMethod) {
      const length = request.headers.get('content-length');
      const tooLarge =
        length === null ? request.headers.has('transfer-encoding') : !(Number(length) >= 0 && Number(length) <= MAX_BODY_BYTES);
      if (tooLarge) return refuse('BAD_REQUEST', 'Request body is too large.');
    }

    const routePath = routePathOf(url.pathname);
    if (sessions.passwordRequired && handlerType === 'router' && isApiPath(routePath) && !OPEN_API_PATHS.has(routePath)) {
      const unlocked = Option.exists(yield* client.session, (session) => session.unlocked);
      if (!unlocked) return refuse('APP_LOCKED', LOCKED_MESSAGE);
    }
    return { headers, refusal: null };
  });

/**
 * Every HTTP request, before it is handled. A refused 'router' request gets its refusal Response
 * (`refusal`); a refused 'serverFn' request makes this THROW the AppError. Otherwise the request
 * goes on, and its response goes through `secureResponse`.
 */
export async function guardRequest(input: GuardInput): Promise<GuardedRequest> {
  const { headers, refusal } = await runEffect(inspect(input));
  const secureResponse = (response: Response) => withHeaders(response, headers);
  if (refusal === null) return { refusal: undefined, secureResponse };
  if (input.handlerType === 'serverFn') {
    // Start turns the thrown AppError into its own error response (secureResponse never sees
    // it), merging in the headers set on the request event.
    setResponseHeaders(new Headers(headers));
    throw refusal;
  }
  const body: ApiErrorBody = { error: { code: refusal.code, message: refusal.message } };
  return { refusal: secureResponse(Response.json(body, { status: httpStatusOf[refusal.code] })), secureResponse };
}

/** What Start's compiler records about the server function being called. */
export interface ServerFnInfo {
  /** Opaque id (a hash in production). */
  readonly id: string;
  /** Export name, e.g. "getAppAuthStatus". */
  readonly name: string;
  /** Source file relative to the project root, e.g. "src/server/functions/app-auth.ts". */
  readonly filename: string;
}

/** No password is set, or this request's session (its cookie, read by the bridge) entered it. */
const currentUnlocked = Effect.gen(function* () {
  const { passwordRequired } = yield* Sessions;
  if (!passwordRequired) return true;
  return Option.exists(yield* currentSession, (session) => session.unlocked);
});

/**
 * Every server-function call (HTTP and SSR), before its validator and handler: the APP_PASSWORD
 * gate. Throws AppError APP_LOCKED unless no password is set or the `faceslop_session` cookie
 * names an unlocked session (during SSR, the page request's cookie); the functions in
 * src/server/functions/app-auth.ts stay reachable so the UI can show the password screen. Matched
 * on `filename` (stable across dev and production builds), not on `id`.
 */
export async function guardServerFn(fn: ServerFnInfo): Promise<void> {
  if (isOpenServerFn(fn.filename)) return;
  if (!(await runEffect(currentUnlocked))) throw new AppError({ code: 'APP_LOCKED', message: LOCKED_MESSAGE });
}
