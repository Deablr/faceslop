// Start's server entry (auto-detected at src/server.ts). Builds the Effect runtime at boot so the
// database is migrated and the background checker runs without waiting for the first request.
//
// Two things happen here, outside Start's middleware:
// - A path starting with "//" (or "/\") is answered 404. Start would otherwise answer it itself,
//   before any middleware, with an absolute 308 redirect built from the request URL: http://
//   behind a TLS-terminating proxy, to whatever Host was sent. Nothing faceslop serves starts so.
// - Responses Start or Nitro produce without passing the request guard's response hook (that
//   404, errors thrown after the middleware) get the same security headers (finishUnguarded).
import handler, { createServerEntry } from '@tanstack/react-start/server-entry';
import { startRuntime } from '@/server/runtime';
import { finishUnguarded } from '@/server/security/request-guard';

startRuntime();

const PROTOCOL_RELATIVE = /^\/[/\\]/;

export default createServerEntry({
  fetch: async (request) => {
    if (PROTOCOL_RELATIVE.test(new URL(request.url).pathname)) {
      return finishUnguarded(new Response('Not found', { status: 404 }), request);
    }
    return finishUnguarded(await handler.fetch(request), request);
  },
});
