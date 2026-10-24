// City / neighborhood lookup for the location picker. Port of legacy/src/server/fb/locations.ts.
//
// Replays Facebook's own location typeahead query (MarketplaceSearchAddressDataSourceQuery) from a
// warm hidden facebook.com page. If the replay stops working (e.g. Facebook rotated the query's
// doc id), it falls back to typing into Marketplace's location dialog and reading the response
// Facebook's own UI requests, which also teaches us the current doc id.
//
// - Results are cached for a day (case-insensitively), concurrent lookups of the same query share
//   one request, and failures are not cached.
// - Lookups always run as the anonymous profile (place names don't depend on who asks, and no
//   account's cookies are used for them), one at a time on the shared helper page (a Semaphore).
//   The cache is shared by everyone for the same reason.
// - The helper page lives in its own Scope (a child of the layer's) and is closed after
//   HELPER_IDLE_MS without use by a sweeper fiber, or when it died with the browser context.
//   closeHelper doesn't wait for a lookup in flight: that lookup notices its page died and runs
//   once more on a fresh helper (the same happens when the anonymous context is reset).
import '@tanstack/react-start/server-only';
import { Cache, Clock, Duration, Effect, Equal, Exit, Fiber, Hash, Option, Ref, Result, Schema, Scope, Semaphore } from 'effect';
import type { Page, Response } from 'playwright';
import type { BrowserShape } from '@/server/browser/Browser';
import {
  extractLocationOptions,
  extractPageTokens,
  extractSearchLocation,
  graphqlErrors,
  hasLocationResults,
  parseGraphqlBody,
  type PageTokens,
} from '@/server/marketplace/extract';
import {
  bestEffort,
  dismissLoginModal,
  fbTimeout,
  graphqlInPage,
  graphqlRequest,
  interactionError,
  isVisible,
  loadFacebookPage,
  STALL_TIMEOUT_MS,
} from '@/server/marketplace/fb-page';
import { MARKETPLACE_HOME } from '@/server/marketplace/urls';
import { ANONYMOUS_PROFILE } from '@/server/session/identity';
import type { LocationOption } from '@/shared/domain';
import { AppError } from '@/shared/errors';

export const LOCATION_FRIENDLY_NAME = 'MarketplaceSearchAddressDataSourceQuery';
/** Last known doc id; AppConfig.locationDocId (FACESLOP_LOCATION_DOC_ID) overrides it, and the dialog fallback updates it. */
export const DEFAULT_LOCATION_DOC_ID = '9660140454040174';

export const LOCATION_CACHE_TTL = Duration.days(1);
const LOCATION_CACHE_MAX = 500;
/** Keep the lookup page open briefly so typeahead keystrokes don't each pay for a page load. */
export const HELPER_IDLE_MS = 2 * 60_000;
const HELPER_SWEEP_MS = 15_000;
const DIALOG_TIMEOUT_MS = 12_000;
const MAX_QUERY_LENGTH = 100;

// ---------- pure helpers (unit-tested) ----------

/** The query as Facebook gets it: trimmed, inner whitespace collapsed. */
export const normalizeLocationQuery = (query: string): string => query.trim().replace(/\s+/g, ' ');

/** Variables of the typeahead query, as Facebook's own picker sends them. */
export const typeaheadVariables = (query: string) => ({
  params: {
    caller: 'MARKETPLACE',
    country_filter: null,
    integration_strategy: 'STRING_MATCH',
    page_category: ['CITY', 'SUBCITY', 'NEIGHBORHOOD', 'POSTAL_CODE'],
    query,
    search_type: 'PLACE_TYPEAHEAD',
    // Facebook's own picker sends null; viewer coordinates bias results away from big cities.
    viewer_coordinates: null,
  },
});

/** Typeahead response documents as location options, actual cities first; FB_PARSE_FAILED when it isn't an answer. */
export function readLocationOptions(docs: readonly unknown[]): Result.Result<LocationOption[], AppError> {
  if (!hasLocationResults(docs)) {
    const error = graphqlErrors(docs)[0];
    return Result.fail(
      new AppError({
        code: 'FB_PARSE_FAILED',
        message: error ? `Facebook location search failed: ${error}` : 'Facebook location search returned no results field.',
      }),
    );
  }
  // Facebook's logged-out ranking is erratic; list actual cities first, otherwise keep its order.
  const options = extractLocationOptions(docs);
  return Result.succeed([...options.filter((o) => o.subtitle === 'City'), ...options.filter((o) => o.subtitle !== 'City')]);
}

const TypeaheadForm = Schema.Struct({
  fb_api_req_friendly_name: Schema.Literal(LOCATION_FRIENDLY_NAME),
  variables: Schema.fromJsonString(Schema.Struct({ params: Schema.Struct({ query: Schema.String }) })),
});
const decodeTypeaheadForm = Schema.decodeUnknownOption(TypeaheadForm);

/** True when a request body is Facebook's own typeahead request for `query`. */
export function isTypeaheadRequestFor(postData: string | null, query: string): boolean {
  const form = Object.fromEntries(new URLSearchParams(postData ?? ''));
  return Option.exists(decodeTypeaheadForm(form), (decoded) => decoded.variables.params.query === query);
}

/** Cache key: compares case-insensitively, but keeps the text the user typed for Facebook. */
export class LocationQuery implements Equal.Equal {
  readonly key: string;
  constructor(readonly text: string) {
    this.key = text.toLowerCase();
  }
  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof LocationQuery && that.key === this.key;
  }
  [Hash.symbol](): number {
    return Hash.string(this.key);
  }
}

// ---------- service part ----------

interface Helper {
  /** Owns the page. */
  readonly scope: Scope.Closeable;
  readonly page: Page;
  readonly tokens: PageTokens;
  readonly lastUsedAt: number;
}

export interface LocationSearch {
  /** Queries shorter than 2 characters return [], longer than 100 are BAD_REQUEST. */
  readonly searchLocations: (query: string) => Effect.Effect<readonly LocationOption[], AppError>;
  /** Close the warm lookup page now (it reopens on the next lookup). */
  readonly closeHelper: Effect.Effect<void>;
  /** The doc id the next replay uses (diagnostics and tests). */
  readonly docId: Effect.Effect<string>;
}

export interface LocationSearchOptions {
  /** Doc id override (AppConfig.locationDocId). */
  readonly docId?: string | undefined;
  readonly helperIdleMs?: number;
  readonly helperSweepMs?: number;
  readonly dialogTimeoutMs?: number;
}

/** Requires the layer's Scope: the helper page's scope is a child of it, the idle sweeper a scoped fiber. */
export const makeLocationSearch = Effect.fn('Marketplace.makeLocationSearch')(function* (
  browser: BrowserShape,
  options: LocationSearchOptions = {},
) {
  const layerScope = yield* Effect.scope;
  const helperIdleMs = options.helperIdleMs ?? HELPER_IDLE_MS;
  const dialogTimeoutMs = options.dialogTimeoutMs ?? DIALOG_TIMEOUT_MS;
  const docId = yield* Ref.make(options.docId ?? DEFAULT_LOCATION_DOC_ID);
  const helperRef = yield* Ref.make<Helper | null>(null);
  /** One lookup at a time on the shared helper page; also guards opening/closing it. */
  const lock = yield* Semaphore.make(1);

  const closeHelper: Effect.Effect<void> = Effect.flatMap(Ref.getAndSet(helperRef, null), (helper) =>
    helper ? Scope.close(helper.scope, Exit.void) : Effect.void,
  );

  /**
   * A fresh helper page on facebook.com/marketplace/ (for its origin, cookies and request tokens),
   * registered as the current helper. Its scope closes if opening fails or is interrupted, so a
   * half-opened page never outlives the attempt.
   */
  const openHelper = (now: number) =>
    Effect.gen(function* () {
      const scope = yield* Scope.fork(layerScope);
      return yield* Effect.gen(function* () {
        const page = yield* browser.openPage(ANONYMOUS_PROFILE).pipe(Scope.provide(scope));
        const { html } = yield* loadFacebookPage(page, MARKETPLACE_HOME);
        const helper: Helper = { scope, page, tokens: extractPageTokens(html), lastUsedAt: now };
        yield* Ref.set(helperRef, helper);
        return helper;
      }).pipe(Effect.onError(() => Scope.close(scope, Exit.void)));
    });

  /** The warm helper, (re)opened when missing or dead (it dies with the browser context). Hold `lock`. */
  const getHelper = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const current = yield* Ref.get(helperRef);
    if (current && !current.page.isClosed()) {
      const touched = { ...current, lastUsedAt: now };
      yield* Ref.set(helperRef, touched);
      return touched;
    }
    if (current) yield* closeHelper;
    return yield* openHelper(now);
  });

  // Close the helper once it has been idle for helperIdleMs (never in the middle of a lookup).
  const closeIfIdle = lock.withPermits(1)(
    Effect.gen(function* () {
      const helper = yield* Ref.get(helperRef);
      const now = yield* Clock.currentTimeMillis;
      if (helper && (helper.page.isClosed() || now - helper.lastUsedAt >= helperIdleMs)) yield* closeHelper;
    }),
  );
  yield* Effect.forkScoped(Effect.forever(Effect.andThen(Effect.sleep(options.helperSweepMs ?? HELPER_SWEEP_MS), closeIfIdle)));

  const replay = Effect.fnUntraced(function* (helper: Helper, query: string) {
    const request = graphqlRequest(helper.tokens, LOCATION_FRIENDLY_NAME, yield* Ref.get(docId), typeaheadVariables(query));
    const docs = yield* graphqlInPage(helper.page, request);
    return yield* Effect.fromResult(readLocationOptions(docs));
  });

  const interact = <A>(run: () => Promise<A>, what: string) =>
    Effect.tryPromise({ try: run, catch: (cause) => interactionError(cause, what, 'Facebook location search timed out.') });

  /** Fallback: type into Marketplace's location dialog and read the response Facebook's own UI requests. */
  const viaDialog = Effect.fnUntraced(function* (helper: Helper, query: string) {
    const page = helper.page;
    const { html, blobs } = yield* loadFacebookPage(page, MARKETPLACE_HOME);
    const tokens = extractPageTokens(html);
    yield* Ref.update(helperRef, (current) => (current?.page === page ? { ...current, tokens } : current));
    yield* dismissLoginModal(page);

    const currentName = extractSearchLocation(blobs)?.name;
    const openers = [
      page.getByText(/^Within \d+/).first(),
      ...(currentName ? [page.getByText(currentName, { exact: true }).first()] : []),
    ];
    let opened = false;
    for (const opener of openers) {
      if (yield* isVisible(opener)) {
        yield* bestEffort(() => opener.click({ timeout: 3000 }));
        opened = true;
        break;
      }
    }
    if (!opened) return yield* new AppError({ code: 'FB_PARSE_FAILED', message: "Couldn't find Marketplace's location picker." });

    const input = page
      .locator(
        'div[role="dialog"] input[aria-label="Location"], div[role="dialog"] input[type="search"], div[role="dialog"] input[type="text"]',
      )
      .first();
    yield* interact(() => input.waitFor({ state: 'visible', timeout: dialogTimeoutMs }), "Couldn't open Marketplace's location picker");

    // Listen before typing: the request goes out on the last keystroke.
    const answer = yield* Effect.forkChild(
      interact(
        () => page.waitForResponse((r) => isTypeaheadRequestFor(r.request().postData(), query), { timeout: dialogTimeoutMs }),
        'Facebook location search failed',
      ),
      { startImmediately: true },
    );
    yield* interact(() => input.fill(''), "Couldn't type into Marketplace's location picker");
    yield* interact(() => input.pressSequentially(query, { delay: 40 }), "Couldn't type into Marketplace's location picker");
    const response: Response = yield* Fiber.join(answer);

    const learned = new URLSearchParams(response.request().postData() ?? '').get('doc_id');
    if (learned) yield* Ref.set(docId, learned);
    yield* bestEffort(() => page.keyboard.press('Escape'));
    const text = yield* interact(() => response.text(), "Couldn't read Facebook's location search response").pipe(
      Effect.timeoutOrElse({ duration: STALL_TIMEOUT_MS, orElse: () => Effect.fail(fbTimeout('Facebook location search timed out.')) }),
    );
    return yield* Effect.fromResult(readLocationOptions(parseGraphqlBody(text)));
  });

  /** Replay the typeahead query; if that fails for any reason but a block, go through the dialog. */
  const lookupOn = Effect.fnUntraced(function* (helper: Helper, query: string) {
    const replayed = yield* Effect.result(replay(helper, query));
    if (Result.isSuccess(replayed)) return replayed.success;
    // A block won't go away by clicking around; anything else may be a rotated doc id.
    if (replayed.failure.code === 'FB_BLOCKED') return yield* replayed.failure;
    // The page died under us (closeHelper, or the anonymous browser context was reset).
    if (helper.page.isClosed()) return yield* replayed.failure;
    return yield* viaDialog(helper, query);
  });

  const lookup = (query: LocationQuery) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const helper = yield* getHelper;
        const first = yield* Effect.result(lookupOn(helper, query.text));
        if (Result.isSuccess(first)) return first.success;
        if (!helper.page.isClosed()) return yield* first.failure;
        // Once more on a fresh helper page.
        return yield* lookupOn(yield* getHelper, query.text);
      }),
    );

  const cache = yield* Cache.makeWith(lookup, {
    capacity: LOCATION_CACHE_MAX,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? LOCATION_CACHE_TTL : Duration.zero),
  });

  const searchLocations = Effect.fn('Marketplace.searchLocations')(function* (query: string) {
    const q = normalizeLocationQuery(query);
    if (q.length < 2) return [];
    if (q.length > MAX_QUERY_LENGTH) return yield* new AppError({ code: 'BAD_REQUEST', message: 'Location search is too long.' });
    const found = yield* Cache.get(cache, new LocationQuery(q));
    return found.map((option) => ({ ...option }));
  });

  return {
    searchLocations,
    closeHelper,
    docId: Ref.get(docId),
  } satisfies LocationSearch;
});
