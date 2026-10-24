// Listing detail. Port of legacy/src/server/fb/item.ts.
//
// One hidden page per lookup (Browser.withPage, as the asking profile). Results are cached for
// LISTING_CACHE_TTL in an effect Cache keyed by profile + listing id (what Facebook shows depends
// on the viewer: canMessage, hasMessaged), which also de-duplicates concurrent lookups of the
// same listing by the same profile. Failures are never cached (time to live zero), so a timeout or
// block is retried on the next request. Callers get copies, so per-request tweaks (e.g. the server
// function's `canMessage && loggedIn`) never leak into the cache.
import '@tanstack/react-start/server-only';
import { Cache, Duration, Effect, Equal, Exit, Hash } from 'effect';
import type { BrowserShape } from '@/server/browser/Browser';
import { extractErrorRoute, extractListingDetail, hasProductDetailsPage } from '@/server/marketplace/extract';
import { loadFacebookPage, looksLikeLoginWall } from '@/server/marketplace/fb-page';
import { listingUrl } from '@/server/marketplace/urls';
import { profileKey, type FbProfile } from '@/server/session/identity';
import type { ListingDetail } from '@/shared/domain';
import { AppError } from '@/shared/errors';

export const LISTING_CACHE_TTL = Duration.minutes(5);
export const LISTING_CACHE_MAX = 200;

/** Marketplace ids are numeric; anything longer than 20 digits sends Facebook into a redirect loop. */
const LISTING_ID = /^\d{1,20}$/;

const notFound = () => new AppError({ code: 'NOT_FOUND', message: 'This listing is no longer available on Facebook.' });

/** Cache key: one listing as one profile sees it. */
export class ListingKey implements Equal.Equal {
  /** profileKey of the profile it is looked up as. */
  readonly owner: string;
  constructor(
    readonly profile: FbProfile,
    readonly id: string,
  ) {
    this.owner = profileKey(profile);
  }
  [Equal.symbol](that: Equal.Equal): boolean {
    return that instanceof ListingKey && that.owner === this.owner && that.id === this.id;
  }
  [Hash.symbol](): number {
    return Hash.string(`${this.owner}/${this.id}`);
  }
}

export interface ListingDetails {
  /**
   * Full listing detail as `profile` sees it (cached per profile). NOT_FOUND when the listing is
   * gone, BAD_REQUEST for ids Facebook can't take.
   */
  readonly getListing: (profile: FbProfile, id: string) => Effect.Effect<ListingDetail, AppError>;
  readonly forgetListing: (profile: FbProfile, id: string) => Effect.Effect<void>;
  /** Drop every listing cached for `profile` (other profiles keep theirs). */
  readonly clearCache: (profile: FbProfile) => Effect.Effect<void>;
}

export interface ListingDetailsOptions {
  readonly timeToLive?: Duration.Input;
}

export const makeListingDetails = Effect.fn('Marketplace.makeListingDetails')(function* (
  browser: BrowserShape,
  options: ListingDetailsOptions = {},
) {
  const timeToLive = options.timeToLive ?? LISTING_CACHE_TTL;

  const fetchListing = ({ profile, id }: ListingKey) =>
    browser.withPage(profile, (page) =>
      Effect.gen(function* () {
        // A redirect loop on an item URL means Facebook has no such listing.
        const { html, blobs } = yield* loadFacebookPage(page, listingUrl(id), notFound);
        const detail = extractListingDetail(blobs, id);
        if (detail) return detail;
        // Removed/bogus ids render Facebook's "This content isn't available" route.
        if (extractErrorRoute(blobs) !== null || hasProductDetailsPage(blobs)) return yield* notFound();
        if (looksLikeLoginWall(html)) {
          return yield* new AppError({ code: 'FB_BLOCKED', message: 'Facebook is asking to log in before showing this listing.' });
        }
        return yield* new AppError({
          code: 'FB_PARSE_FAILED',
          message: "Facebook's listing page loaded, but the listing couldn't be read.",
        });
      }),
    );

  const cache = yield* Cache.makeWith(fetchListing, {
    capacity: LISTING_CACHE_MAX,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? timeToLive : Duration.zero),
  });

  const getListing = Effect.fn('Marketplace.getListing')(function* (profile: FbProfile, id: string) {
    const clean = id.trim();
    if (!LISTING_ID.test(clean)) return yield* new AppError({ code: 'BAD_REQUEST', message: 'Listing id must be numeric.' });
    const detail = yield* Cache.get(cache, new ListingKey(profile, clean));
    return structuredClone(detail);
  });

  const clearCache = (profile: FbProfile) =>
    Effect.flatMap(Cache.keys(cache), (keys) => {
      const owner = profileKey(profile);
      // Collected first: invalidating while iterating the cache's own map would skip entries.
      const mine = Array.from(keys).filter((key) => key.owner === owner);
      return Effect.forEach(mine, (key) => Cache.invalidate(cache, key), { discard: true });
    });

  return {
    getListing,
    forgetListing: (profile: FbProfile, id: string) => Cache.invalidate(cache, new ListingKey(profile, id.trim())),
    clearCache,
  } satisfies ListingDetails;
});
