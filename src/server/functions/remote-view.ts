// Remote view controls for THIS browser's view (replaces legacy POST /api/focus and the headed
// windows). Frames and state arrive over SSE from GET /api/remote/stream
// (src/routes/api/remote/stream.ts), which streams only the caller's own view.
import { createServerFn } from '@tanstack/react-start';
import { Effect, Option } from 'effect';
import { Auth } from '@/server/auth/Auth';
import { runEffect, validate } from '@/server/bridge';
import { RemoteView } from '@/server/remote-view/RemoteView';
import { currentSession, ensureSession } from '@/server/session/CurrentClient';
import { profileOf } from '@/server/session/identity';
import { AppError } from '@/shared/errors';
import { CLOSED_REMOTE_VIEW_STATE, OpenRemoteViewRequest, RemoteInputEvent } from '@/shared/remote-view';

export const getRemoteViewState = createServerFn({ method: 'GET' }).handler(() =>
  runEffect(
    Effect.flatMap(currentSession, (session) =>
      Option.isNone(session) ? Effect.succeed(CLOSED_REMOTE_VIEW_STATE) : RemoteView.use((view) => view.state(session.value.id)),
    ),
  ),
);

/**
 * 'login' goes through Auth so its login watcher runs (already logged in: nothing opens and the
 * closed state comes back); other targets open directly with this browser's Facebook account.
 * NOT_LOGGED_IN for inbox/selling/create when this browser isn't logged in to Facebook.
 */
export const openRemoteView = createServerFn({ method: 'POST' })
  .validator(validate(OpenRemoteViewRequest))
  .handler(({ data }) =>
    runEffect(
      Effect.gen(function* () {
        if (data.target !== 'login') {
          const session = yield* ensureSession;
          return yield* RemoteView.use((view) => view.open(session.id, profileOf(session), data));
        }
        const session = yield* ensureSession;
        const status = yield* Auth.use((auth) => auth.openLoginView(session));
        if (status.state === 'error') {
          return yield* new AppError({ code: 'INTERNAL', message: status.message ?? "Couldn't open Facebook's login page." });
        }
        return yield* RemoteView.use((view) => view.state(session.id));
      }),
    ),
  );

/** Closes this browser's view (an account view's cookies are saved back). Always succeeds (no-op when closed). */
export const closeRemoteView = createServerFn({ method: 'POST' }).handler(() =>
  runEffect(
    Effect.flatMap(currentSession, (session) =>
      Option.isNone(session) ? Effect.succeed(CLOSED_REMOTE_VIEW_STATE) : RemoteView.use((view) => view.close(session.value.id)),
    ),
  ),
);

/** One input event. The viewer should coalesce mouse moves (about 30 per second is plenty). Never logged. */
export const remoteInput = createServerFn({ method: 'POST' })
  .validator(validate(RemoteInputEvent))
  .handler(({ data }) =>
    runEffect(
      Effect.flatMap(currentSession, (session) =>
        Option.isNone(session)
          ? Effect.fail(new AppError({ code: 'BAD_REQUEST', message: 'No remote view is open.' }))
          : RemoteView.use((view) => view.input(session.value.id, data)),
      ),
    ),
  );
