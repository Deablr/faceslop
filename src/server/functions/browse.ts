// Browsing Marketplace: search, load more, listing detail, locations, categories.
// Legacy: GET /api/search, POST /api/search/:sessionId/more, GET /api/listings/:id,
// GET /api/locations, GET /api/categories.
//
// Facebook is read as this browser's Facebook account when it is logged in, else anonymously
// (src/server/session/identity.ts). Search params go to Facebook exactly as the UI sent them: the
// server never fills in a default location or radius (the UI writes Settings.defaultLocation into
// the URL when a new search starts; no location means "use my Facebook location"). Results are
// filtered locally with this browser's owner's filters (hidden listings, blocked sellers, excluded
// keywords) and report how many were filtered.
import { createServerFn } from '@tanstack/react-start';
import { Effect, Option } from 'effect';
import { Auth } from '@/server/auth/Auth';
import { runEffect, validate } from '@/server/bridge';
import { toSearchResult } from '@/server/filters';
import { Marketplace } from '@/server/marketplace/Marketplace';
import { currentOwner, currentProfile, currentSession } from '@/server/session/CurrentClient';
import {
  ListingRequest,
  LoadMoreRequest,
  LocationsRequest,
  SearchParams,
  type ListingDetail,
  type LocationOption,
} from '@/shared/domain';

export const search = createServerFn({ method: 'GET' })
  .validator(validate(SearchParams))
  .handler(({ data }) =>
    runEffect(
      Effect.gen(function* () {
        const profile = yield* currentProfile;
        const page = yield* Marketplace.use((marketplace) => marketplace.search(profile, data));
        return yield* toSearchResult(yield* currentOwner)(page);
      }),
    ),
  );

export const loadMore = createServerFn({ method: 'POST' })
  .validator(validate(LoadMoreRequest))
  .handler(({ data }) =>
    runEffect(
      Effect.gen(function* () {
        const profile = yield* currentProfile;
        const page = yield* Marketplace.use((marketplace) => marketplace.loadMore(profile, data.sessionId));
        return yield* toSearchResult(yield* currentOwner)(page);
      }),
    ),
  );

export const getListing = createServerFn({ method: 'GET' })
  .validator(validate(ListingRequest))
  .handler(({ data }) =>
    runEffect(
      Effect.gen(function* () {
        const profile = yield* currentProfile;
        const detail = yield* Marketplace.use((marketplace) => marketplace.getListing(profile, data.id));
        // Facebook's canMessage means "messageable"; sending also needs this browser to be logged
        // in. A failing session check counts as logged out (legacy: isLoggedIn().catch(() => false)).
        const session = yield* currentSession;
        const loggedIn =
          detail.canMessage && Option.isSome(session)
            ? yield* Auth.use((auth) => auth.isLoggedIn(session.value)).pipe(Effect.catchDefect(() => Effect.succeed(false)))
            : false;
        return { ...detail, canMessage: detail.canMessage && loggedIn } satisfies ListingDetail;
      }),
    ),
  );

export const getLocations = createServerFn({ method: 'GET' })
  .validator(validate(LocationsRequest))
  .handler(({ data }) =>
    runEffect(
      data.q.length < 2
        ? Effect.succeed<readonly LocationOption[]>([])
        : Marketplace.use((marketplace) => marketplace.searchLocations(data.q)),
    ),
  );

export const getCategories = createServerFn({ method: 'GET' }).handler(() =>
  runEffect(Marketplace.use((marketplace) => marketplace.categories)),
);
