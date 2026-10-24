// Message a seller from our UI, as the caller's Facebook account. OWNER: auth builder.
//
// Port of legacy/src/server/fb/messaging.ts: opens the listing in the account's hidden (logged-in)
// browser context and uses Facebook's own "Send seller a message" box (composer.ts). Anything
// unexpected returns `fallbackToWindow: true` so the UI can offer the remote view on that listing
// instead. One send per account and listing at a time; a repeated identical request gets the same
// result. A send runs in the service's scope, so a client that disconnects mid-send can't leave
// it half done (and Send is never pressed twice).
//
// When Facebook bounces the listing to its login page, a live check (session-probe.ts) confirms
// the session is dead and deletes the account's saved session (the binding stays), so the UI shows
// the login screen. An open remote view of the account doesn't write that dead login back when it
// closes (RemoteView checks it against the saved session). Depends on Browser and Marketplace only
// (not Auth, not RemoteView).
//
// Errors: NOT_LOGGED_IN (no saved session for the account, or Facebook logged it out), BAD_REQUEST.
import '@tanstack/react-start/server-only';
import { Context, Deferred, Effect, Layer } from 'effect';
import type { Page } from 'playwright';
import { isAuthUrl, isLoginUrl } from '@/server/auth/auth-parse';
import { forgetDeadSession, probeAccountSession } from '@/server/auth/session-probe';
import { Browser } from '@/server/browser/Browser';
import { Marketplace } from '@/server/marketplace/Marketplace';
import { ALREADY_MESSAGED, type ComposerOptions, sendViaComposer } from '@/server/messaging/composer';
import { remoteTargetUrl } from '@/server/remote-view/targets';
import { type FbUserId, accountProfile } from '@/server/session/identity';
import { notImplemented } from '@/server/stub';
import { type ListingId, MAX_MESSAGE_LENGTH, type SendMessageResult } from '@/shared/domain';
import { AppError } from '@/shared/errors';

export interface MessagingShape {
  /**
   * Message a seller as `userId` (the caller checked that this browser is bound to that account;
   * NOT_LOGGED_IN when the account has no saved Facebook session). `text` is already trimmed and
   * 1..1000 characters (validated by the server function).
   */
  readonly sendMessage: (userId: FbUserId, listingId: ListingId, text: string) => Effect.Effect<SendMessageResult, AppError>;
}

export interface MessagingOptions {
  /** Composer timeouts (tests use shorter ones). */
  readonly composer?: Omit<ComposerOptions, 'log'>;
}

const fallback = (message: string): SendMessageResult => ({ ok: false, message, fallbackToWindow: true });

/** Load the listing and send through its composer. 'logged_out' when Facebook sent us to its login page. */
async function sendOnListingPage(
  page: Page,
  url: string,
  text: string,
  options: Omit<ComposerOptions, 'log'>,
): Promise<SendMessageResult | 'logged_out'> {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch {
    return fallback("Facebook didn't load the listing in time. Try again, or open it in the Marketplace view.");
  }
  if (isLoginUrl(page.url())) return 'logged_out';
  if (isAuthUrl(page.url())) {
    return fallback('Facebook wants you to confirm something about your account first. Open the Marketplace view to sort it out.');
  }
  return sendViaComposer(page, text, options);
}

const make = Effect.fnUntraced(function* (options: MessagingOptions = {}) {
  const browser = yield* Browser;
  const marketplace = yield* Marketplace;
  const layerScope = yield* Effect.scope;

  // One send per account and listing at a time; a repeated request (double click) gets the same result.
  const inFlight = new Map<string, { readonly text: string; readonly result: Deferred.Deferred<SendMessageResult, AppError> }>();

  const send = (userId: FbUserId, id: ListingId, url: string, text: string) =>
    Effect.gen(function* () {
      const profile = accountProfile(userId);
      const result = yield* browser.withPage(profile, (page) =>
        Effect.tryPromise(() => sendOnListingPage(page, url, text, options.composer ?? {})).pipe(
          // Never retried: the message may or may not have gone out.
          Effect.orElseSucceed(() =>
            fallback('Something went wrong while sending. Check the conversation in the Marketplace view before trying again.'),
          ),
        ),
      );
      if (result === 'logged_out') {
        // The saved session looks dead. A live check (outside withPage: it needs a page slot)
        // confirms it and deletes it, so the UI shows the login screen.
        const { check, token } = yield* probeAccountSession(browser, userId);
        if (check.kind === 'logged_out' && (yield* forgetDeadSession(browser, userId, token))) {
          yield* Effect.andThen(marketplace.closeAllSessions(profile), marketplace.clearListingCache(profile)).pipe(Effect.ignoreCause);
        }
        return yield* new AppError({ code: 'NOT_LOGGED_IN', message: 'Facebook logged you out. Log in again to message sellers.' });
      }
      if (result.ok || result.message === ALREADY_MESSAGED) {
        // The cached detail's hasMessaged is stale now.
        yield* marketplace.forgetListing(profile, id).pipe(Effect.ignoreCause);
      }
      return result;
    });

  const sendMessage = Effect.fn('Messaging.sendMessage')(function* (userId: FbUserId, listingId: ListingId, text: string) {
    const id = listingId.trim();
    const url = remoteTargetUrl('listing', id);
    if (url === null) return yield* new AppError({ code: 'BAD_REQUEST', message: 'Invalid listing id.' });
    const body = text.trim();
    if (body === '') return yield* new AppError({ code: 'BAD_REQUEST', message: 'Write a message first.' });
    if (body.length > MAX_MESSAGE_LENGTH) {
      return yield* new AppError({ code: 'BAD_REQUEST', message: `Messages can be at most ${MAX_MESSAGE_LENGTH} characters.` });
    }
    if (!(yield* browser.hasSession(userId))) {
      return yield* new AppError({ code: 'NOT_LOGGED_IN', message: 'Log in to Facebook to message sellers.' });
    }

    const key = `${userId}:${id}`;
    const pending = inFlight.get(key);
    if (pending) {
      if (pending.text === body) return yield* Deferred.await(pending.result);
      return { ok: false, message: 'Still sending your previous message to this seller.', fallbackToWindow: false };
    }
    const result = Deferred.makeUnsafe<SendMessageResult, AppError>();
    inFlight.set(key, { text: body, result });
    yield* send(userId, id, url, body).pipe(
      Effect.onExit((exit) =>
        Effect.andThen(
          Effect.sync(() => inFlight.delete(key)),
          Deferred.done(result, exit),
        ),
      ),
      Effect.forkIn(layerScope),
    );
    return yield* Deferred.await(result);
  });

  return Messaging.of({ sendMessage });
});

export class Messaging extends Context.Service<Messaging, MessagingShape>()('faceslop/server/Messaging') {
  static readonly layerStub = Layer.succeed(
    Messaging,
    Messaging.of({
      sendMessage: () => notImplemented('Messaging.sendMessage'),
    }),
  );

  /** Requires Browser and Marketplace. Options are for tests. */
  static readonly layerNoDeps = (options?: MessagingOptions) => Layer.effect(Messaging, make(options));

  /** The layer the app runs. */
  static readonly layer = Layer.effect(Messaging, make()).pipe(Layer.provide([Browser.layer, Marketplace.layer]));
}
