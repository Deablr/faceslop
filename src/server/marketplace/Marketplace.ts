// Reading Facebook Marketplace: search with "load more" sessions, listing detail, location
// typeahead, categories. OWNER: engine builder.
//
// Port of legacy/src/server/fb/{search,item,locations,categories,extract,urls}.ts. Pages come from
// the Browser service (`withPage` for one-shot loads, `openPage` in a Scope the engine owns for
// search sessions and the location helper page), always from the hidden context of the profile
// asking (an account without a saved session is served anonymously by Browser itself). State is
// kept per profile: search sessions belong to the profile that opened them, cached listings are
// per profile; location lookups always run anonymously. The parts:
//   search.ts     search + "load more" sessions (pool of hidden pages, three pagination strategies)
//   listing.ts    listing detail (cached per profile, de-duplicated)
//   locations.ts  location typeahead (warm anonymous helper page, replay + dialog fallback)
//   fb-page.ts    loading facebook.com pages / calling GraphQL from them, Playwright errors -> AppError
//   extract.ts, conform.ts, urls.ts, categories.ts   pure (no Playwright), unit-tested against test/fixtures/
//
// Errors: AppError FB_BLOCKED (login wall / checkpoint / rate limit), FB_PARSE_FAILED, FB_TIMEOUT,
// NOT_FOUND (listing gone), SESSION_EXPIRED (loadMore on a dead or another profile's session), BAD_REQUEST (unknown
// category, ids Facebook can't take), INTERNAL (the hidden browser failed).
import '@tanstack/react-start/server-only';
import { Context, Effect, Layer, Option } from 'effect';
import { Browser } from '@/server/browser/Browser';
import { AppConfig } from '@/server/config';
import type { FbProfile } from '@/server/session/identity';
import { CATEGORIES } from '@/server/marketplace/categories';
import { makeListingDetails } from '@/server/marketplace/listing';
import { makeLocationSearch } from '@/server/marketplace/locations';
import { makeSearchEngine } from '@/server/marketplace/search';
import { notImplemented } from '@/server/stub';
import type {
  Category,
  ListingDetail,
  ListingId,
  ListingSummary,
  LocationOption,
  SearchLocationInfo,
  SearchParams,
} from '@/shared/domain';
import type { AppError } from '@/shared/errors';

/** One page of raw search results (before local filtering, which the server function applies). */
export interface SearchPage {
  /** Handle for loadMore(); null when there are no more pages. */
  readonly sessionId: string | null;
  /** Raw (unfiltered) listings for this page, de-duplicated within the session. */
  readonly listings: readonly ListingSummary[];
  readonly hasMore: boolean;
  readonly location: SearchLocationInfo | null;
}

export interface MarketplaceShape {
  /**
   * Run a search with exactly these params, as `profile` (nothing is filled in: no location =
   * Facebook's account/IP location; no query and no category = the nearby "Today's picks" feed,
   * which ignores filters). Keeps a hidden page open as a session when there are more pages; the
   * session belongs to `profile`.
   */
  readonly search: (profile: FbProfile, params: SearchParams) => Effect.Effect<SearchPage, AppError>;
  /**
   * The first page only, keeping no session (background checks: they must not evict the
   * sessions people are paging through). `sessionId` is always null and `hasMore` false.
   */
  readonly searchFirstPage: (profile: FbProfile, params: SearchParams) => Effect.Effect<SearchPage, AppError>;
  /** Next page of a search session. SESSION_EXPIRED when the session is gone or belongs to another profile. */
  readonly loadMore: (profile: FbProfile, sessionId: string) => Effect.Effect<SearchPage, AppError>;
  /** Close one of `profile`'s search sessions (no-op for unknown ids or another profile's). */
  readonly closeSession: (profile: FbProfile, sessionId: string) => Effect.Effect<void>;
  /** Close every search session of `profile` (after its login/logout: pages under the old cookies are stale). */
  readonly closeAllSessions: (profile: FbProfile) => Effect.Effect<void>;
  /** Full listing detail as `profile` sees it (cached briefly per profile). NOT_FOUND when the listing is gone. */
  readonly getListing: (profile: FbProfile, id: ListingId) => Effect.Effect<ListingDetail, AppError>;
  /** Drop one cached listing for `profile` (e.g. after messaging the seller changes hasMessaged). */
  readonly forgetListing: (profile: FbProfile, id: ListingId) => Effect.Effect<void>;
  /** Drop `profile`'s cached listings (after its login/logout: canMessage/hasMessaged depend on the viewer). */
  readonly clearListingCache: (profile: FbProfile) => Effect.Effect<void>;
  /** City / neighborhood typeahead (always as the anonymous profile). Queries shorter than 2 characters return []. */
  readonly searchLocations: (query: string) => Effect.Effect<readonly LocationOption[], AppError>;
  /** Marketplace categories with verified slugs (static). */
  readonly categories: Effect.Effect<readonly Category[]>;
}

export class Marketplace extends Context.Service<Marketplace, MarketplaceShape>()('faceslop/server/Marketplace') {
  static readonly layerStub = Layer.succeed(
    Marketplace,
    Marketplace.of({
      search: () => notImplemented('Marketplace.search'),
      searchFirstPage: () => notImplemented('Marketplace.searchFirstPage'),
      loadMore: () => notImplemented('Marketplace.loadMore'),
      closeSession: () => notImplemented('Marketplace.closeSession'),
      closeAllSessions: () => notImplemented('Marketplace.closeAllSessions'),
      getListing: () => notImplemented('Marketplace.getListing'),
      forgetListing: () => notImplemented('Marketplace.forgetListing'),
      clearListingCache: () => notImplemented('Marketplace.clearListingCache'),
      searchLocations: () => notImplemented('Marketplace.searchLocations'),
      categories: notImplemented('Marketplace.categories'),
    }),
  );

  /** Requires Browser and AppConfig (tests provide a Browser of their own). */
  static readonly layerNoDeps = Layer.effect(
    Marketplace,
    Effect.gen(function* () {
      const browser = yield* Browser;
      const config = yield* AppConfig;
      const searches = yield* makeSearchEngine(browser);
      const listings = yield* makeListingDetails(browser);
      const locations = yield* makeLocationSearch(browser, { docId: Option.getOrUndefined(config.locationDocId) });
      return Marketplace.of({
        search: searches.search,
        searchFirstPage: searches.searchFirstPage,
        loadMore: searches.loadMore,
        closeSession: searches.closeSession,
        // The location helper page is anonymous: no account's login or logout makes it stale.
        closeAllSessions: searches.closeAllSessions,
        getListing: listings.getListing,
        forgetListing: listings.forgetListing,
        clearListingCache: listings.clearCache,
        searchLocations: locations.searchLocations,
        categories: Effect.succeed(CATEGORIES),
      });
    }),
  );

  /** The layer the app runs. Browser and AppConfig are shared (layers are memoized by reference). */
  static readonly layer = Marketplace.layerNoDeps.pipe(Layer.provide([Browser.layer, AppConfig.layer]));
}
