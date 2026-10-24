// Global Start configuration: serialization adapters and middleware for every request / server function.
//
// This module is isomorphic. `.server()` callbacks are stripped from the client build, so the
// server-only modules they call never reach the browser (their `server-only` marker would fail
// the build if they did).
//
// The security checks themselves live in src/server/security/request-guard.ts (see its header for
// why there are two hooks: request middleware cannot tell which server function is called).
import { createMiddleware, createStart } from '@tanstack/react-start';
import { guardRequest, guardServerFn } from '@/server/security/request-guard';
import { appErrorSerializationAdapter } from '@/shared/errors';

/** Header every server-function call carries; the request guard refuses non-GET requests without it (CSRF). */
export const CSRF_HEADER = 'x-faceslop';

/**
 * Client side of every server function call: add `x-faceslop: 1`. A cross-site page cannot send a
 * custom header without a CORS preflight, which faceslop never grants.
 */
const csrfHeader = createMiddleware({ type: 'function' }).client(({ next }) =>
  next({ headers: { [CSRF_HEADER]: '1' } }),
);

/** Server side of every server function call, HTTP and SSR alike: the APP_PASSWORD gate. */
const appLock = createMiddleware({ type: 'function' }).server(async ({ next, serverFnMeta }) => {
  await guardServerFn(serverFnMeta);
  return next();
});

/** Every HTTP request: Host, CSRF, body size, APP_PASSWORD for /api/* routes; then response headers (HSTS over HTTPS). */
const securityMiddleware = createMiddleware().server(async ({ request, handlerType, next }) => {
  const guarded = await guardRequest({ request, handlerType });
  if (guarded.refusal) return guarded.refusal;
  const result = await next();
  return { ...result, response: guarded.secureResponse(result.response) };
});

export const startInstance = createStart(() => ({
  serializationAdapters: [appErrorSerializationAdapter],
  requestMiddleware: [securityMiddleware],
  functionMiddleware: [csrfHeader, appLock],
}));
