// GET /api/remote/stream's body and response, with a stand-in RemoteView: SSE framing, the
// heartbeat (TestClock), the stream ending (unsubscribing) when the request aborts, and who gets
// which stream (the caller's own session; none: closed + retry; locked: APP_LOCKED).
import { assert, describe, it } from '@effect/vitest';
import { Effect, Fiber, Layer, Option, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { RemoteView } from '@/server/remote-view/RemoteView';
import { SSE_HEADERS, remoteSseBody, remoteStream, remoteStreamResponse } from '@/server/remote-view/sse';
import { CurrentClient, EMPTY_REQUEST_INFO } from '@/server/session/CurrentClient';
import type { ClientSession, ClientSessionId } from '@/server/session/identity';
import { Sessions } from '@/server/session/Sessions';
import { notImplemented } from '@/server/stub';
import { AppError } from '@/shared/errors';
import { CLOSED_REMOTE_VIEW_STATE, type RemoteStreamEvent, decodeRemoteSseMessage } from '@/shared/remote-view';

const SESSION_ID = 'session-a' as ClientSessionId;

/** A RemoteView whose events are `events` (then nothing, forever); counts live subscriptions and records whose. */
function fakeRemoteView(events: readonly RemoteStreamEvent[]) {
  const counter = { subscribed: 0, sessions: [] as ClientSessionId[] };
  const layer = Layer.succeed(
    RemoteView,
    RemoteView.of({
      open: () => Effect.succeed(CLOSED_REMOTE_VIEW_STATE),
      close: () => Effect.succeed(CLOSED_REMOTE_VIEW_STATE),
      input: () => Effect.void,
      state: () => Effect.succeed(CLOSED_REMOTE_VIEW_STATE),
      events: (sessionId) =>
        Stream.fromIterable(events).pipe(
          Stream.concat(Stream.never),
          Stream.onStart(
            Effect.sync(() => {
              counter.subscribed++;
              counter.sessions.push(sessionId);
            }),
          ),
          Stream.ensuring(
            Effect.sync(() => {
              counter.subscribed--;
            }),
          ),
        ),
      page: () => Effect.succeed(Option.none()),
    }),
  );
  return { layer, counter };
}

/** The caller (CurrentClient) and the app password setting (Sessions) for remoteStream. */
function callerLayer(session: ClientSession | null, passwordRequired: boolean) {
  const client = Layer.succeed(
    CurrentClient,
    CurrentClient.of({
      request: EMPTY_REQUEST_INFO,
      address: null,
      secure: false,
      token: undefined,
      session: Effect.succeed(Option.fromNullishOr(session)),
      ensureSession: notImplemented('CurrentClient.ensureSession'),
      issue: () => notImplemented('CurrentClient.issue'),
    }),
  );
  const sessions = Layer.succeed(
    Sessions,
    Sessions.of({
      passwordRequired,
      resolve: () => notImplemented('Sessions.resolve'),
      get: () => notImplemented('Sessions.get'),
      create: notImplemented('Sessions.create'),
      unlock: () => notImplemented('Sessions.unlock'),
      lock: () => notImplemented('Sessions.lock'),
      bindAccount: () => notImplemented('Sessions.bindAccount'),
      unbindAccount: () => notImplemented('Sessions.unbindAccount'),
    }),
  );
  return Layer.mergeAll(client, sessions);
}

/** Read a body to its end (it must end by itself). */
const readAll = (response: Response) => Effect.promise(() => response.text());

/** Split an SSE text body into (name, data) messages, skipping comments and the retry hint. */
function parseSse(text: string): { readonly name: string; readonly data: string }[] {
  return text
    .split('\n\n')
    .filter((block) => block.startsWith('event: '))
    .map((block) => {
      const [eventLine = '', dataLine = ''] = block.split('\n');
      return { name: eventLine.slice('event: '.length), data: dataLine.slice('data: '.length) };
    });
}

describe('remoteSseBody', () => {
  it.effect('starts with a retry hint, then the events', () =>
    Effect.gen(function* () {
      const chunks = yield* remoteSseBody(Stream.make('event: state\ndata: {}\n\n')).pipe(Stream.runCollect);
      assert.deepStrictEqual(chunks, ['retry: 3000\n\n', 'event: state\ndata: {}\n\n']);
    }),
  );

  it.effect('sends a heartbeat comment every 15 seconds while nothing happens', () =>
    Effect.gen(function* () {
      const fiber = yield* remoteSseBody(Stream.never).pipe(Stream.take(3), Stream.runCollect, Effect.forkChild);
      // Step the clock so each tick's sleep is registered before time passes it.
      for (let i = 0; i < 12; i++) {
        yield* Effect.yieldNow;
        yield* TestClock.adjust('4 seconds');
      }
      assert.deepStrictEqual(yield* Fiber.join(fiber), ['retry: 3000\n\n', ': keep-alive\n\n', ': keep-alive\n\n']);
    }),
  );

  it.live('ends when the request aborts (the events stream never ends by itself)', () =>
    Effect.gen(function* () {
      const controller = new AbortController();
      const fiber = yield* remoteSseBody(Stream.never, controller.signal).pipe(Stream.runCollect, Effect.forkChild);
      yield* Effect.sleep('50 millis');
      controller.abort();
      assert.deepStrictEqual(yield* Fiber.join(fiber), ['retry: 3000\n\n']);

      const already = new AbortController();
      already.abort();
      assert.deepStrictEqual(yield* remoteSseBody(Stream.never, already.signal).pipe(Stream.runCollect), ['retry: 3000\n\n']);
    }),
  );
});

describe('remoteStreamResponse', () => {
  it.live('answers text/event-stream with the protocol messages, and unsubscribes on abort', () =>
    Effect.gen(function* () {
      const frame: RemoteStreamEvent = { _tag: 'frame', data: '/9j/AA==', width: 2, height: 1 };
      const state: RemoteStreamEvent = { _tag: 'state', ...CLOSED_REMOTE_VIEW_STATE };
      const fake = fakeRemoteView([state, frame, { _tag: 'closed' }]);
      const controller = new AbortController();
      const response = yield* remoteStreamResponse(SESSION_ID, controller.signal).pipe(Effect.provide(fake.layer));

      assert.strictEqual(response.status, 200);
      for (const [name, value] of Object.entries(SSE_HEADERS)) assert.strictEqual(response.headers.get(name), value);
      assert.strictEqual(response.headers.get('cache-control'), 'no-store');

      const body = response.body;
      assert.isNotNull(body);
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (parseSse(text).length < 3) {
        const chunk = yield* Effect.promise(() => reader.read());
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      assert.isTrue(text.startsWith('retry: 3000\n\n'));
      const decoded = parseSse(text).map(({ name, data }) => decodeRemoteSseMessage(name, data));
      assert.deepStrictEqual(decoded, [state, frame, { _tag: 'closed' }]);
      assert.strictEqual(fake.counter.subscribed, 1);
      assert.deepStrictEqual(fake.counter.sessions, [SESSION_ID]);

      // The client goes away: the body ends and the subscription is released.
      controller.abort();
      const end = yield* Effect.promise(() => reader.read());
      assert.isTrue(end.done);
      yield* Effect.sleep('20 millis');
      assert.strictEqual(fake.counter.subscribed, 0);
    }),
  );

  it.live('unsubscribes when the body is cancelled (the socket closed, the signal never aborted)', () =>
    Effect.gen(function* () {
      const fake = fakeRemoteView([{ _tag: 'state', ...CLOSED_REMOTE_VIEW_STATE }]);
      const response = yield* remoteStreamResponse(SESSION_ID, new AbortController().signal).pipe(Effect.provide(fake.layer));
      const body = response.body;
      assert.isNotNull(body);
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (!text.includes('event: state')) {
        const chunk = yield* Effect.promise(() => reader.read());
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      assert.strictEqual(fake.counter.subscribed, 1);
      yield* Effect.promise(() => reader.cancel());
      yield* Effect.sleep('20 millis');
      assert.strictEqual(fake.counter.subscribed, 0);
    }),
  );
});

describe('remoteStream (who gets which stream)', () => {
  const state: RemoteStreamEvent = { _tag: 'state', ...CLOSED_REMOTE_VIEW_STATE, open: true, target: 'inbox' };

  it.live("streams the caller's own session", () =>
    Effect.gen(function* () {
      const fake = fakeRemoteView([state]);
      const controller = new AbortController();
      const session: ClientSession = { id: SESSION_ID, unlocked: true, fbUserId: null };
      const response = yield* remoteStream(controller.signal).pipe(Effect.provide(Layer.mergeAll(fake.layer, callerLayer(session, true))));
      assert.strictEqual(response.status, 200);
      const reader = response.body?.getReader();
      assert.isDefined(reader);
      const decoder = new TextDecoder();
      let text = '';
      while (parseSse(text).length < 1) {
        const chunk = yield* Effect.promise(() => reader.read());
        if (chunk.done) break;
        text += decoder.decode(chunk.value, { stream: true });
      }
      assert.deepStrictEqual(
        parseSse(text).map(({ name, data }) => decodeRemoteSseMessage(name, data)),
        [state],
      );
      assert.deepStrictEqual(fake.counter.sessions, [SESSION_ID]);
      controller.abort();
      yield* Effect.promise(() => reader.cancel());
    }),
  );

  it.live('without a session: reports the closed state, then ends with a retry hint (EventSource reconnects)', () =>
    Effect.gen(function* () {
      const fake = fakeRemoteView([state]);
      const response = yield* remoteStream(new AbortController().signal).pipe(Effect.provide(Layer.mergeAll(fake.layer, callerLayer(null, false))));
      assert.strictEqual(response.status, 200);
      for (const [name, value] of Object.entries(SSE_HEADERS)) assert.strictEqual(response.headers.get(name), value);
      const text = yield* readAll(response);
      assert.deepStrictEqual(
        parseSse(text).map(({ name, data }) => decodeRemoteSseMessage(name, data)),
        [{ _tag: 'state', ...CLOSED_REMOTE_VIEW_STATE }],
      );
      assert.isTrue(text.endsWith('retry: 3000\n\n'));
      assert.deepStrictEqual(fake.counter.sessions, [], 'no view was subscribed');
    }),
  );

  it.effect('with APP_PASSWORD set, a missing or locked session is APP_LOCKED', () =>
    Effect.gen(function* () {
      const fake = fakeRemoteView([state]);
      const locked: ClientSession = { id: SESSION_ID, unlocked: false, fbUserId: null };
      for (const session of [null, locked]) {
        const error = yield* Effect.flip(remoteStream().pipe(Effect.provide(Layer.mergeAll(fake.layer, callerLayer(session, true)))));
        assert.instanceOf(error, AppError);
        assert.strictEqual(error.code, 'APP_LOCKED');
      }
      assert.deepStrictEqual(fake.counter.sessions, []);
    }),
  );
});
