// GET /api/remote/stream: the CALLER's remote view (RemoteView.events of its browser session) as
// Server-Sent Events. OWNER: auth builder (protocol in src/shared/remote-view.ts).
//
// - Who is asking comes from CurrentClient (the session cookie, read by the bridge). With
//   APP_PASSWORD set, a missing or locked session gets APP_LOCKED (the request guard already gates
//   /api/*; this stream shows Facebook pages, so it checks again). Without a session at all there
//   is no view to show: the body reports the closed state and ends with a `retry:` hint, so
//   EventSource reconnects (by then the POST that opened a view has set the cookie). This route
//   never creates sessions.
// - One SSE message per event (`event: state|frame|closed`), a comment heartbeat every 15 s so
//   proxies and the browser keep the connection, and a `retry:` hint for EventSource.
// - Never completes on its own (RemoteView.events spans views). It ends when the client goes
//   away: `request.signal` aborts, or the response body is cancelled; both interrupt the
//   subscription, which unsubscribes from the session's channel.
import '@tanstack/react-start/server-only';
import { Effect, Option, Stream } from 'effect';
import { RemoteView } from '@/server/remote-view/RemoteView';
import { currentSession } from '@/server/session/CurrentClient';
import type { ClientSessionId } from '@/server/session/identity';
import { Sessions } from '@/server/session/Sessions';
import { AppError } from '@/shared/errors';
import { CLOSED_REMOTE_VIEW_STATE, encodeRemoteSseMessage } from '@/shared/remote-view';

export const HEARTBEAT_INTERVAL = '15 seconds';
/** EventSource waits this long before reconnecting after a dropped (or ended) connection. */
const RETRY_MS = 3000;
const RETRY_HINT = `retry: ${RETRY_MS}\n\n`;

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-store',
  'x-accel-buffering': 'no',
};

/** Completes when `signal` aborts (never, without a signal). */
const abortedBy = (signal: AbortSignal | undefined): Effect.Effect<void> =>
  signal === undefined
    ? Effect.never
    : Effect.callback((resume: (effect: Effect.Effect<void>) => void) => {
        if (signal.aborted) {
          resume(Effect.void);
          return;
        }
        const onAbort = () => {
          resume(Effect.void);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        return Effect.sync(() => {
          signal.removeEventListener('abort', onAbort);
        });
      });

/** The SSE body (text), until `signal` aborts. Exported for tests. */
export const remoteSseBody = (events: Stream.Stream<string>, signal?: AbortSignal): Stream.Stream<string> => {
  const heartbeat = Stream.tick(HEARTBEAT_INTERVAL).pipe(
    Stream.drop(1),
    Stream.map(() => ': keep-alive\n\n'),
  );
  return Stream.succeed(RETRY_HINT).pipe(
    Stream.concat(Stream.merge(events, heartbeat, { haltStrategy: 'left' })),
    Stream.interruptWhen(abortedBy(signal)),
  );
};

/** Live events of `sessionId`'s view, until `signal` aborts. */
export const remoteStreamResponse = Effect.fn('remoteStreamResponse')(function* (sessionId: ClientSessionId, signal?: AbortSignal) {
  const view = yield* RemoteView;
  // Fail before committing to a 200 (e.g. while the service is still a stub).
  yield* view.state(sessionId);
  const body = remoteSseBody(view.events(sessionId).pipe(Stream.map(encodeRemoteSseMessage)), signal).pipe(Stream.encodeText);
  const readable = yield* Stream.toReadableStreamEffect(body);
  return new Response(readable, { headers: SSE_HEADERS });
});

/** For a browser without a session: the closed state, then a retry hint, then the end. */
export const noSessionStreamResponse = Effect.gen(function* () {
  const body = Stream.make(encodeRemoteSseMessage({ _tag: 'state', ...CLOSED_REMOTE_VIEW_STATE }), RETRY_HINT).pipe(Stream.encodeText);
  const readable = yield* Stream.toReadableStreamEffect(body);
  return new Response(readable, { headers: SSE_HEADERS });
});

/** GET /api/remote/stream for the current request's browser session. */
export const remoteStream = Effect.fn('remoteStream')(function* (signal?: AbortSignal) {
  const sessions = yield* Sessions;
  const session = yield* currentSession;
  if (sessions.passwordRequired && !Option.exists(session, (current) => current.unlocked)) {
    return yield* new AppError({ code: 'APP_LOCKED', message: 'Enter the faceslop password first.' });
  }
  if (Option.isNone(session)) return yield* noSessionStreamResponse;
  return yield* remoteStreamResponse(session.value.id, signal);
});
