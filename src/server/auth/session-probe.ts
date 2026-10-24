// A live check of an account's saved Facebook session, shared by Auth (status with `verify`) and
// Messaging (a send that bounced to Facebook's login page). Plain functions over the Browser
// service (not a service: Messaging must not depend on Auth). OWNER: auth builder.
import '@tanstack/react-start/server-only';
import { Effect } from 'effect';
import { type SessionCheck, classifySessionPage, sessionTokenFromCookies } from '@/server/auth/auth-parse';
import { type BrowserShape, FB_ORIGIN } from '@/server/browser/Browser';
import { MARKETPLACE_URL } from '@/server/remote-view/targets';
import { type FbUserId, accountProfile } from '@/server/session/identity';

/** A live check of a saved session, and which login (xs token) it checked. */
export interface Probe {
  readonly check: SessionCheck;
  readonly token: string | null;
}

export const UNKNOWN_PROBE: Probe = { check: { kind: 'unknown' }, token: null };

/** Load Marketplace with the account's saved session and see who Facebook thinks we are. Never fails. */
export const probeAccountSession = (browser: BrowserShape, userId: FbUserId): Effect.Effect<Probe> =>
  browser
    .withPage(accountProfile(userId), (page) =>
      Effect.tryPromise(async (): Promise<Probe> => {
        const token = sessionTokenFromCookies(await page.context().cookies(FB_ORIGIN));
        const response = await page.goto(MARKETPLACE_URL, { waitUntil: 'commit', timeout: 20_000 });
        const html = response ? await response.text().catch(() => null) : null;
        return { check: classifySessionPage(page.url(), html), token };
      }),
    )
    .pipe(Effect.orElseSucceed(() => UNKNOWN_PROBE));

/** True when the account's saved session is still the login whose xs token is `token` (no new login replaced it). */
export const isSavedLogin = (browser: BrowserShape, userId: FbUserId, token: string | null): Effect.Effect<boolean> =>
  browser.getCookies(accountProfile(userId)).pipe(
    Effect.map((saved) => sessionTokenFromCookies(saved) === token),
    Effect.orElseSucceed(() => false),
  );

/**
 * Facebook ended the account's login whose xs token is `token`: delete its saved session, unless
 * a new login replaced it meanwhile (then false). The account's binding to browser sessions is
 * kept (its local data still belongs to it); status reports logged_out until it logs in again.
 */
export const forgetDeadSession = (browser: BrowserShape, userId: FbUserId, token: string | null): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (!(yield* isSavedLogin(browser, userId, token))) return false;
    yield* browser.clearSession(userId).pipe(Effect.ignore);
    return true;
  });
