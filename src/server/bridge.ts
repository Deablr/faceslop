// The bridge between TanStack Start server functions and the Effect runtime. OWNER: foundation.
//
//   createServerFn({ method: 'POST' })
//     .validator(validate(SomeSchema))          // Effect Schema decode; failure -> AppError BAD_REQUEST
//     .handler(({ data }) => runEffect(...))     // AppError -> client as is; anything else -> INTERNAL
//
// How errors reach the client: Start serializes a thrown value with Seroval. Its default plugin
// keeps only `message` for Error instances, so AppError has its own serialization adapter
// (appErrorSerializationAdapter, registered in src/start.ts) that carries `code` + `message`.
// Proven by test/server-fn-http.test.ts against a real Start server.
//
// Who is calling: every Effect run here can use CurrentClient (src/server/session/CurrentClient.ts).
// The request is read synchronously BEFORE the Effect runs and the session cookie is set AFTER it
// finishes, both in the request's own async context (Start's request helpers use
// AsyncLocalStorage, which Effect's scheduler does not reliably carry into fibers).
import '@tanstack/react-start/server-only';
import { getRequest, getRequestIP, setCookie } from '@tanstack/react-start/server';
import { Cause, Effect, Exit, Option, Predicate, Schema, SchemaIssue } from 'effect';
import { type AppServices, getRuntime } from '@/server/runtime';
import { cookieValue } from '@/server/security/cookies';
import {
  type CookieToSet,
  CurrentClient,
  EMPTY_REQUEST_INFO,
  type RequestInfo,
  makeCurrentClient,
} from '@/server/session/CurrentClient';
import { SECURE_SESSION_COOKIE, SESSION_COOKIE, SESSION_COOKIE_MAX_AGE_S } from '@/server/session/Sessions';
import { type ApiErrorBody, AppError, INTERNAL_MESSAGE, httpStatusOf } from '@/shared/errors';

/** What an Effect run through the bridge can use. */
export type BridgeServices = AppServices | CurrentClient;

/** The current request's cookie and addresses (all empty outside a request, e.g. in unit tests). */
export function readRequestInfo(request?: Request): RequestInfo {
  try {
    const current = request ?? getRequest();
    const headers = current.headers;
    let remoteAddress: string | null = null;
    try {
      remoteAddress = getRequestIP() ?? null;
    } catch {
      remoteAddress = null; // no request event (e.g. a Request handed in by a test)
    }
    return {
      token: cookieValue(headers.get('cookie'), SESSION_COOKIE),
      secureToken: cookieValue(headers.get('cookie'), SECURE_SESSION_COOKIE),
      remoteAddress,
      forwardedFor: headers.get('x-forwarded-for'),
      forwardedProto: headers.get('x-forwarded-proto'),
      protocol: URL.canParse(current.url) ? new URL(current.url).protocol.replace(/:$/, '') : null,
      method: current.method,
    };
  } catch {
    return EMPTY_REQUEST_INFO;
  }
}

function writeSessionCookie(cookie: CookieToSet | undefined): void {
  if (cookie === undefined) return;
  try {
    // Over HTTPS: the __Host- name (Secure, Path=/, no Domain), so nobody can plant one.
    setCookie(cookie.secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE, cookie.token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      secure: cookie.secure,
      maxAge: SESSION_COOKIE_MAX_AGE_S,
    });
  } catch {
    // Not in a request (unit tests): nothing to set.
  }
}

/** Run `effect` with CurrentClient for `info`; returns the Exit and the cookie to set, if any. */
async function runWithClient<A, E>(
  effect: Effect.Effect<A, E, BridgeServices>,
  info: RequestInfo,
): Promise<{ readonly exit: Exit.Exit<A, unknown>; readonly cookie: CookieToSet | undefined }> {
  let cookie: CookieToSet | undefined;
  const client = makeCurrentClient(info, (next) => {
    cookie = next;
  });
  const exit = await getRuntime().runPromiseExit(Effect.provideServiceEffect(effect, CurrentClient, client));
  return { exit, cookie };
}

/**
 * Run a server function's Effect on the app runtime. Resolves with its value; rejects with the
 * AppError it failed with, or with AppError INTERNAL (after logging the full cause) for any other
 * failure, defect, or interruption. A session created or re-issued along the way gets its cookie
 * either way.
 */
export async function runEffect<A, E>(effect: Effect.Effect<A, E, BridgeServices>): Promise<A> {
  const { exit, cookie } = await runWithClient(effect, readRequestInfo());
  writeSessionCookie(cookie);
  if (Exit.isSuccess(exit)) return exit.value;
  throw toAppError(exit.cause);
}

/**
 * For plain HTTP server routes (src/routes/api/*): run an Effect that builds a Response; on
 * failure answer with a JSON `ApiErrorBody` and the code's HTTP status. CurrentClient comes from
 * `request` (these routes must not create sessions: no cookie is set).
 */
export async function runEffectResponse<E>(
  effect: Effect.Effect<Response, E, BridgeServices>,
  request?: Request,
): Promise<Response> {
  const { exit } = await runWithClient(effect, readRequestInfo(request));
  if (Exit.isSuccess(exit)) return exit.value;
  const error = toAppError(exit.cause);
  const body: ApiErrorBody = { error: { code: error.code, message: error.message } };
  return Response.json(body, { status: httpStatusOf[error.code], headers: { 'cache-control': 'no-store' } });
}

/** The AppError a failed Effect should surface to the client. Logs everything that isn't an AppError. */
export function toAppError(cause: Cause.Cause<unknown>): AppError {
  const failure = Cause.findErrorOption(cause);
  if (Option.isSome(failure) && failure.value instanceof AppError) return failure.value;
  console.error(`[server] unexpected failure:\n${Cause.pretty(cause)}`);
  return new AppError({ code: 'INTERNAL', message: INTERNAL_MESSAGE });
}

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/** "params.radiusKm: Expected a value between 1 and 500; name: is required" (first 5 issues). */
export function describeSchemaError(error: Schema.SchemaError): string {
  return formatIssues(error.issue)
    .issues.slice(0, 5)
    .map((issue) => {
      const path = (issue.path ?? []).map((segment) => (typeof segment === 'object' ? String(segment.key) : String(segment)));
      return path.length > 0 ? `${path.join('.')}: ${issue.message}` : issue.message;
    })
    .join('; ');
}

/** A `{...}` literal (not a Date, Map, class instance, ...). */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (!Predicate.isObject(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * Drop object keys whose value is `undefined` (deeply), so they count as absent.
 *
 * TypeScript accepts `{ query: undefined }` for `query?: string` (exactOptionalPropertyTypes is
 * off), and Seroval sends that `undefined` over the wire, but `Schema.optionalKey` and
 * `withDecodingDefaultKey` only accept a missing key. Legacy sent JSON, which dropped such keys.
 */
export function dropUndefinedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropUndefinedKeys);
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) out[key] = dropUndefinedKeys(entry);
  }
  return out;
}

/**
 * A server-function validator from an Effect Schema. The client passes the schema's Encoded type;
 * the handler receives the decoded Type. Optional keys set to `undefined` count as absent.
 * Invalid input fails with AppError BAD_REQUEST (the message never includes the input itself, so
 * passwords are not echoed).
 */
export function validate<T, E>(schema: Schema.Codec<T, E, never, unknown>): { readonly parse: (input: E) => T } {
  const decode = Schema.decodeUnknownExit(schema);
  return {
    parse: (input) => {
      const exit = decode(dropUndefinedKeys(input), { errors: 'all' });
      if (Exit.isSuccess(exit)) return exit.value;
      const error = Cause.findErrorOption(exit.cause);
      throw new AppError({
        code: 'BAD_REQUEST',
        message: Option.isSome(error) ? describeSchemaError(error.value) : 'Invalid request.',
      });
    },
  };
}

/** Fail with an AppError (shorthand for `new AppError({ code, message })` in pipelines). */
export const fail = (code: AppError['code'], message: string): Effect.Effect<never, AppError> =>
  Effect.fail(new AppError({ code, message }));
