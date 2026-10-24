// App password gate (APP_PASSWORD): status, unlock, lock. Always reachable, even when locked.
// Unlocking never expires: it lasts as long as this browser keeps its session cookie (and the
// APP_PASSWORD stays the same). Legacy: GET /api/app-auth, POST /api/app-auth/{login,logout}.
import { createServerFn } from '@tanstack/react-start';
import { Effect, Option, Redacted } from 'effect';
import { runEffect, validate } from '@/server/bridge';
import { RemoteView } from '@/server/remote-view/RemoteView';
import { CurrentClient, appAuthStatus, currentSession } from '@/server/session/CurrentClient';
import { Sessions } from '@/server/session/Sessions';
import { AppLoginRequest, type AppAuthStatus } from '@/shared/domain';

export const getAppAuthStatus = createServerFn({ method: 'GET' }).handler(() => runEffect(appAuthStatus));

export const appLogin = createServerFn({ method: 'POST' })
  .validator(validate(AppLoginRequest))
  .handler(({ data }) =>
    runEffect(
      Effect.gen(function* () {
        const sessions = yield* Sessions;
        if (!sessions.passwordRequired) return { required: false, authenticated: true } satisfies AppAuthStatus;
        const client = yield* CurrentClient;
        const issued = yield* sessions.unlock(client.token, Redacted.make(data.password), client.address);
        yield* client.issue(issued);
        return { required: true, authenticated: true } satisfies AppAuthStatus;
      }),
    ),
  );

/** Lock this browser again (closing its Facebook view). Its Facebook connection and data stay; entering the password unlocks it. */
export const appLogout = createServerFn({ method: 'POST' }).handler(() =>
  runEffect(
    Effect.gen(function* () {
      const sessions = yield* Sessions;
      const session = yield* currentSession;
      if (Option.isSome(session)) {
        // A locked browser keeps nothing live: its Facebook view (and so its stream) closes too.
        yield* RemoteView.use((view) => view.close(session.value.id));
        yield* sessions.lock(session.value.id);
      }
      return yield* appAuthStatus;
    }),
  ),
);
