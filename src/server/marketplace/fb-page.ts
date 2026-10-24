// Loading facebook.com pages and calling Facebook's GraphQL endpoint from inside them, with
// Playwright failures mapped to AppError. Shared by search, listing detail and location lookup.
// Port of the shared helpers in legacy/src/server/fb/search.ts. The detection and request-building
// functions at the top are pure and unit-tested (test/search.test.ts).
import '@tanstack/react-start/server-only';
import { Effect } from 'effect';
import type { Locator, Page } from 'playwright';
import { runInPage } from '@/server/browser/page-script';
import { extractJsonBlobs, jazoest, parseGraphqlBody, type PageTokens } from '@/server/marketplace/extract';
import { AppError } from '@/shared/errors';

const NAV_TIMEOUT_MS = 30_000;
export const GRAPHQL_TIMEOUT_MS = 20_000;
/**
 * Upper bound for Playwright calls that have no timeout of their own (evaluate, response bodies,
 * page.content). Server functions are never interrupted, so a hung renderer would otherwise hold
 * a search session's or the location helper's lock forever.
 */
export const STALL_TIMEOUT_MS = GRAPHQL_TIMEOUT_MS + 10_000;

// ---------- pure: block detection ----------

/** Why a facebook.com URL means we were walled off (login, checkpoint, consent), or null. */
export function blockedReason(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/(^|\.)facebook\.com$/.test(u.hostname)) return `Facebook redirected away from Marketplace (${u.hostname}).`;
  if (/^\/(login|checkpoint|two_step_verification|two_factor|recover|authentication|consent|privacy\/consent)\b/.test(u.pathname)) {
    return 'Facebook is asking to log in or verify the account before showing Marketplace.';
  }
  return null;
}

/**
 * Facebook served its classic login page at the original URL (no redirect). Logged-out Marketplace
 * pages carry a login form too, but they're Comet pages with route info; the login page isn't.
 */
export function looksLikeLoginWall(html: string): boolean {
  return html.includes('id="login_form"') && !html.includes('"initialRouteInfo"');
}

/** Heuristic for Facebook's soft blocks that render at the original URL. */
export function looksRateLimited(html: string): boolean {
  return /You(?:’|'|&#039;)re Temporarily Blocked|You can(?:’|'|&#039;)t use this feature right now/i.test(html);
}

// ---------- pure: GraphQL requests ----------

export interface GraphqlRequest {
  readonly form: URLSearchParams;
  readonly headers: Readonly<Record<string, string>>;
}

/** Build the form body Facebook's web client posts to /api/graphql/. */
export function graphqlRequest(tokens: PageTokens, friendlyName: string, docId: string, variables: unknown): GraphqlRequest {
  const form = new URLSearchParams({ av: tokens.userId, __user: tokens.userId, __a: '1', __comet_req: '15' });
  if (tokens.fbDtsg) form.set('fb_dtsg', tokens.fbDtsg);
  if (tokens.lsd) form.set('lsd', tokens.lsd);
  form.set('jazoest', jazoest(tokens.fbDtsg ?? tokens.lsd ?? ''));
  form.set('fb_api_caller_class', 'RelayModern');
  form.set('fb_api_req_friendly_name', friendlyName);
  form.set('server_timestamps', 'true');
  form.set('variables', JSON.stringify(variables));
  form.set('doc_id', docId);
  const headers: Record<string, string> = { 'x-fb-friendly-name': friendlyName };
  if (tokens.lsd) headers['x-fb-lsd'] = tokens.lsd;
  return { form, headers };
}

// ---------- pure: error mapping ----------

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
const isTimeout = (cause: unknown): boolean => cause instanceof Error && cause.name === 'TimeoutError';
const CLOSED = /Target (page, context or browser )?(has been )?closed|browser has been closed/i;

export const fbTimeout = (message = 'Facebook took too long to respond.') => new AppError({ code: 'FB_TIMEOUT', message });
export const rateLimited = () =>
  new AppError({ code: 'FB_BLOCKED', message: 'Facebook is rate limiting requests. Try again in a few minutes.' });
const redirectLoop = () => new AppError({ code: 'FB_BLOCKED', message: 'Facebook redirected in a loop.' });

/** A failed page.goto / page.content as an AppError. `onRedirectLoop`: what ERR_TOO_MANY_REDIRECTS means here. */
export function navigationError(cause: unknown, onRedirectLoop: () => AppError = redirectLoop): AppError {
  if (cause instanceof AppError) return cause;
  const message = messageOf(cause);
  if (isTimeout(cause)) return fbTimeout();
  if (message.includes('ERR_TOO_MANY_REDIRECTS')) return onRedirectLoop();
  if (CLOSED.test(message)) return new AppError({ code: 'INTERNAL', message: 'The hidden browser closed unexpectedly.' });
  const net = /net::ERR_[A-Z_]+/.exec(message)?.[0];
  if (net) return fbTimeout(`Could not reach Facebook (${net}).`);
  return new AppError({ code: 'INTERNAL', message });
}

/** A failed in-page interaction (evaluate, locator, waitFor*) as an AppError. */
export function interactionError(cause: unknown, what: string, timeoutMessage = 'Facebook took too long to respond.'): AppError {
  if (cause instanceof AppError) return cause;
  if (isTimeout(cause)) return fbTimeout(timeoutMessage);
  const message = messageOf(cause);
  if (CLOSED.test(message)) return new AppError({ code: 'INTERNAL', message: 'The hidden browser closed unexpectedly.' });
  return new AppError({ code: 'FB_PARSE_FAILED', message: `${what} (${message.split('\n')[0] ?? message})` });
}

// ---------- Effect wrappers ----------

/** Run a Playwright call whose failure doesn't matter (best-effort clicks, key presses, mouse moves). */
export const bestEffort = (run: () => Promise<unknown>): Effect.Effect<void> => Effect.ignore(Effect.tryPromise(run));

/** True when the locator is visible right now; false on any error. */
export const isVisible = (locator: Locator): Effect.Effect<boolean> =>
  Effect.tryPromise(() => locator.isVisible()).pipe(Effect.orElseSucceed(() => false));

export interface LoadedPage {
  readonly html: string;
  readonly blobs: readonly unknown[];
  readonly finalUrl: string;
}

/**
 * Navigate a hidden page to a facebook.com URL and parse its embedded JSON.
 * FB_BLOCKED for login walls / checkpoints / rate limits, FB_TIMEOUT for slow or unreachable Facebook.
 */
export const loadFacebookPage = Effect.fn('Marketplace.loadFacebookPage')(function* (
  page: Page,
  url: string,
  onRedirectLoop?: () => AppError,
) {
  const navigate = <A>(run: () => Promise<A>) =>
    Effect.tryPromise({ try: run, catch: (cause) => navigationError(cause, onRedirectLoop) });

  const response = yield* navigate(() => page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }));
  const reason = blockedReason(page.url());
  if (reason !== null) return yield* new AppError({ code: 'FB_BLOCKED', message: reason });
  if (response?.status() === 429) return yield* rateLimited();
  // The served HTML is the most faithful copy of the embedded JSON; the live DOM is the fallback.
  const served = response
    ? yield* Effect.tryPromise(() => response.text()).pipe(
        Effect.orElseSucceed(() => ''),
        Effect.timeoutOrElse({ duration: STALL_TIMEOUT_MS, orElse: () => Effect.succeed('') }),
      )
    : '';
  const html =
    served ||
    (yield* navigate(() => page.content()).pipe(
      Effect.timeoutOrElse({ duration: STALL_TIMEOUT_MS, orElse: () => Effect.fail(fbTimeout()) }),
    ));
  if (looksRateLimited(html)) {
    return yield* new AppError({ code: 'FB_BLOCKED', message: 'Facebook temporarily blocked browsing. Try again later.' });
  }
  return { html, blobs: extractJsonBlobs(html), finalUrl: page.url() } satisfies LoadedPage;
});

interface InPageRequest {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

interface InPageResponse {
  readonly status: number;
  readonly text: string;
  readonly timedOut: boolean;
}

/** Runs inside the facebook.com page (sent as source text by runInPage): self-contained. */
async function postGraphqlFromPage(request: InPageRequest): Promise<InPageResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => {
    ctrl.abort();
  }, request.timeoutMs);
  try {
    const r = await fetch('/api/graphql/', {
      method: 'POST',
      body: request.body,
      headers: request.headers,
      credentials: 'include',
      signal: ctrl.signal,
    });
    return { status: r.status, text: await r.text(), timedOut: false };
  } catch (e) {
    return { status: 0, text: String(e), timedOut: ctrl.signal.aborted };
  } finally {
    clearTimeout(timer);
  }
}

/** POST to /api/graphql/ from inside a facebook.com page (its cookies, its origin). Returns the parsed documents. */
export const graphqlInPage = Effect.fn('Marketplace.graphqlInPage')(function* (page: Page, request: GraphqlRequest) {
  const res = yield* Effect.tryPromise({
    try: () =>
      runInPage(page, postGraphqlFromPage, {
        body: request.form.toString(),
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...request.headers },
        timeoutMs: GRAPHQL_TIMEOUT_MS,
      }),
    catch: (cause) => interactionError(cause, 'Facebook request failed'),
  }).pipe(
    // The in-page fetch aborts itself after GRAPHQL_TIMEOUT_MS; this covers a page that never answers.
    Effect.timeoutOrElse({ duration: STALL_TIMEOUT_MS, orElse: () => Effect.fail(fbTimeout()) }),
  );
  if (res.timedOut) return yield* fbTimeout();
  if (res.status === 429) return yield* rateLimited();
  if (res.status !== 200) {
    return yield* new AppError({
      code: 'FB_PARSE_FAILED',
      message: `Facebook request failed (HTTP ${res.status === 0 ? 'network error' : res.status}).`,
    });
  }
  const docs = parseGraphqlBody(res.text);
  if (docs.length === 0) return yield* new AppError({ code: 'FB_PARSE_FAILED', message: 'Facebook returned an unreadable response.' });
  return docs;
});

/** Close Facebook's logged-out login modal if it's showing (it blocks scrolling and the location picker). */
export const dismissLoginModal = (page: Page): Effect.Effect<void> => {
  const close = page
    .locator('div[role="dialog"] div[aria-label="Close"][role="button"], div[aria-label="Close"][role="button"]')
    .first();
  return Effect.gen(function* () {
    if (yield* isVisible(close)) yield* bestEffort(() => close.click({ timeout: 3000 }));
  });
};
