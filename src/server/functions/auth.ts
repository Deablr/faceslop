// Facebook login / logout for THIS browser (its session; see src/server/session/identity.ts).
// Passwords pass straight through to the Auth service and are never logged or stored.
// Legacy: /api/auth/{status,login,code,window,logout}.
import { createServerFn } from '@tanstack/react-start';
import { Effect, Option } from 'effect';
import { Auth } from '@/server/auth/Auth';
import { runEffect, validate } from '@/server/bridge';
import { currentSession, ensureSession } from '@/server/session/CurrentClient';
import { AuthStatusRequest, LoginCodeRequest, LoginRequest, type AuthStatus } from '@/shared/domain';

const LOGGED_OUT: AuthStatus = { state: 'logged_out', userId: null, userName: null, message: null };

export const getAuthStatus = createServerFn({ method: 'GET' })
  .validator(validate(AuthStatusRequest))
  .handler(({ data }) =>
    runEffect(
      Effect.flatMap(currentSession, (session) =>
        Option.isNone(session)
          ? Effect.succeed(LOGGED_OUT)
          : Auth.use((auth) => auth.status(session.value, { verify: data.verify === true })),
      ),
    ),
  );

export const login = createServerFn({ method: 'POST' })
  .validator(validate(LoginRequest))
  .handler(({ data }) =>
    runEffect(Effect.flatMap(ensureSession, (session) => Auth.use((auth) => auth.loginWithPassword(session, data)))),
  );

export const submitLoginCode = createServerFn({ method: 'POST' })
  .validator(validate(LoginCodeRequest))
  .handler(({ data }) =>
    runEffect(Effect.flatMap(ensureSession, (session) => Auth.use((auth) => auth.submitLoginCode(session, data.code)))),
  );

/** Legacy POST /api/auth/window: log in through the remote view instead of a real window. */
export const openLoginView = createServerFn({ method: 'POST' }).handler(() =>
  runEffect(Effect.flatMap(ensureSession, (session) => Auth.use((auth) => auth.openLoginView(session)))),
);

/** Give up on this browser's login in progress (it stays linked to its account, if any). */
export const cancelLogin = createServerFn({ method: 'POST' }).handler(() =>
  runEffect(
    Effect.flatMap(currentSession, (session) =>
      Option.isNone(session) ? Effect.succeed(LOGGED_OUT) : Auth.use((auth) => auth.cancelLogin(session.value)),
    ),
  ),
);

/** Log out of Facebook on this device (other devices logged in to the same account stay connected). */
export const logout = createServerFn({ method: 'POST' }).handler(() =>
  runEffect(
    Effect.flatMap(currentSession, (session) =>
      Option.isNone(session) ? Effect.succeed(LOGGED_OUT) : Auth.use((auth) => auth.logout(session.value)),
    ),
  ),
);
