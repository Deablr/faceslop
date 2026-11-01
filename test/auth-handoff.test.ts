// Password-attempt ownership transfer with a stubbed Browser and RemoteView (no Chrome): Auth
// must offer the exact page/context/scope, then leave its lifetime to the view on every outcome.
import { assert, describe, it } from '@effect/vitest';
import { Effect, Exit, Layer, Option, Scope, Stream } from 'effect';
import type { BrowserContext, Page } from 'playwright';
import { vi } from 'vitest';
import { Auth } from '@/server/auth/Auth';
import type * as AuthPage from '@/server/auth/auth-page';
import type { AdoptedLoginView, RemoteViewShape } from '@/server/remote-view/RemoteView';
import { RemoteView } from '@/server/remote-view/RemoteView';
import { Browser } from '@/server/browser/Browser';
import { Marketplace } from '@/server/marketplace/Marketplace';
import type { ClientSession, ClientSessionId } from '@/server/session/identity';
import { Sessions } from '@/server/session/Sessions';
import { notImplemented } from '@/server/stub';
import { AppError } from '@/shared/errors';
import { CLOSED_REMOTE_VIEW_STATE, type RemoteViewState } from '@/shared/remote-view';

vi.mock('@/server/auth/auth-page', async (importOriginal) => {
  const actual = await importOriginal<typeof AuthPage>();
  return {
    ...actual,
    fillLoginForm: () => Promise.resolve({ ok: true }),
    waitForLoginOutcome: () => Promise.resolve({ kind: 'needs_view', message: 'Facebook wants you to solve a security check.' }),
  };
});

const SESSION_ID = 'session-a' as ClientSessionId;
const SESSION: ClientSession = { id: SESSION_ID, unlocked: true, fbUserId: null };
const OPEN_LOGIN: RemoteViewState = {
  open: true,
  target: 'login',
  url: 'https://www.facebook.com/checkpoint/',
  title: 'Security check',
  width: 1100,
  height: 860,
};

function fixture(adopt: RemoteViewShape['adoptLogin']) {
  let closeCount = 0;
  let adopted: AdoptedLoginView | undefined;
  const context = {} as BrowserContext;
  const page = {
    context: () => context,
    goto: () => Promise.resolve(null),
    isClosed: () => closeCount > 0,
  } as unknown as Page;
  Object.assign(context, {
    cookies: () => Promise.resolve([]),
    newPage: () => Promise.resolve(page),
  });

  const browser = Layer.succeed(
    Browser,
    Browser.of({
      withPage: () => notImplemented('Browser.withPage'),
      openPage: () => notImplemented('Browser.openPage'),
      hasSession: () => Effect.succeed(false),
      getCookies: () => Effect.succeed([]),
      saveSession: () => notImplemented('Browser.saveSession'),
      resetContext: () => notImplemented('Browser.resetContext'),
      clearSession: () => notImplemented('Browser.clearSession'),
      loginContext: notImplemented('Browser.loginContext'),
      interactiveContext: () =>
        Effect.acquireRelease(
          Effect.succeed(context),
          () =>
            Effect.sync(() => {
              closeCount++;
            }),
        ),
    }),
  );
  const remoteView = Layer.succeed(
    RemoteView,
    RemoteView.of({
      open: () => notImplemented('RemoteView.open'),
      adoptLogin: (sessionId, source) => {
        adopted = source;
        return adopt(sessionId, source);
      },
      close: () =>
        Effect.suspend(() => {
          const current = adopted;
          adopted = undefined;
          return current === undefined ? Effect.succeed(CLOSED_REMOTE_VIEW_STATE) : Effect.as(Scope.close(current.scope, Exit.void), CLOSED_REMOTE_VIEW_STATE);
        }),
      input: () => notImplemented('RemoteView.input'),
      state: () => Effect.succeed(adopted === undefined ? CLOSED_REMOTE_VIEW_STATE : OPEN_LOGIN),
      events: () => Stream.never,
      page: () => Effect.succeed(Option.fromNullishOr(adopted?.page)),
    }),
  );
  const marketplace = Layer.succeed(
    Marketplace,
    Marketplace.of({
      search: () => notImplemented('Marketplace.search'),
      searchFirstPage: () => notImplemented('Marketplace.searchFirstPage'),
      loadMore: () => notImplemented('Marketplace.loadMore'),
      closeSession: () => notImplemented('Marketplace.closeSession'),
      closeAllSessions: () => Effect.void,
      getListing: () => notImplemented('Marketplace.getListing'),
      forgetListing: () => Effect.void,
      clearListingCache: () => Effect.void,
      searchLocations: () => notImplemented('Marketplace.searchLocations'),
      categories: notImplemented('Marketplace.categories'),
    }),
  );
  const sessions = Layer.succeed(
    Sessions,
    Sessions.of({
      passwordRequired: false,
      resolve: () => notImplemented('Sessions.resolve'),
      get: () => Effect.succeed(Option.some(SESSION)),
      create: notImplemented('Sessions.create'),
      unlock: () => notImplemented('Sessions.unlock'),
      lock: () => notImplemented('Sessions.lock'),
      bindAccount: () => notImplemented('Sessions.bindAccount'),
      unbindAccount: () => notImplemented('Sessions.unbindAccount'),
    }),
  );
  const layer = Auth.layerNoDeps({ viewPollMs: 60_000 }).pipe(
    Layer.provide(Layer.mergeAll(browser, remoteView, marketplace, sessions)),
  );
  return {
    layer,
    page,
    context,
    adopted: () => adopted,
    closeCount: () => closeCount,
  };
}

describe('Auth password handoff (stubbed browser)', () => {
  it.effect('offers the exact page, context and scope, then lets the view close them', () => {
    const fake = fixture(() => Effect.succeed(OPEN_LOGIN));
    return Effect.gen(function* () {
      const auth = yield* Auth;
      const status = yield* auth.loginWithPassword(SESSION, { email: 'person@example.com', password: 'not retained' });
      assert.strictEqual(status.state, 'window_open');
      const source = fake.adopted();
      assert.isDefined(source);
      assert.strictEqual(source.page, fake.page);
      assert.strictEqual(source.context, fake.context);
      assert.strictEqual(fake.closeCount(), 0, 'Auth no longer owns the login context');

      assert.strictEqual((yield* auth.cancelLogin(SESSION)).state, 'logged_out');
      assert.strictEqual(fake.closeCount(), 1);
    }).pipe(Effect.provide(fake.layer));
  });

  it.effect('does not close the scope a second time when adoption rejects it', () => {
    const fake = fixture((_sessionId, source) =>
      Effect.andThen(
        Scope.close(source.scope, Exit.void),
        Effect.fail(new AppError({ code: 'BAD_REQUEST', message: 'No view slot is free.' })),
      ),
    );
    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        Auth.use((auth) => auth.loginWithPassword(SESSION, { email: 'person@example.com', password: 'not retained' })),
      );
      assert.strictEqual(error.code, 'BAD_REQUEST');
      assert.strictEqual(error.message, 'No view slot is free.');
      assert.strictEqual(fake.closeCount(), 1);
      assert.strictEqual(fake.adopted()?.page, fake.page);
    }).pipe(Effect.provide(fake.layer));
  });
});
