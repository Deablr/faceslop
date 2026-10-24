import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { RefreshCw, SearchX, SlidersHorizontal, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { FilterPanel } from '@/components/filter-panel';
import { ListingGrid, ListingGridSkeleton } from '@/components/listing-card';
import { SaveSearchButton } from '@/components/save-search-button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Sheet, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useFormat } from '@/hooks/use-format';
import { categoriesQuery, favoritesQuery, queryKeys, savedSearchesQuery, searchQuery, settled } from '@/lib/queries';
import {
  countActiveFilters,
  defaultSearchName,
  describeSearch,
  humanizeSlug,
  isNearbyBrowse,
  searchIdentity,
  toApiParams,
  validateSearchPageSearch,
  type SearchPageSearch,
} from '@/lib/search-params';
import type { ListingSummary, SearchParams } from '@/shared/domain';
import { appErrorOf } from '@/shared/errors';

function pageTitle(params: SearchParams): string {
  if (params.query !== undefined) return params.query;
  if (params.category !== undefined) return humanizeSlug(params.category);
  return 'Nearby';
}

export const Route = createFileRoute('/_app/search')({
  validateSearch: validateSearchPageSearch,
  // Local data only. Results come from Facebook (seconds), so they load on the client.
  loader: ({ context: { queryClient } }) =>
    settled(
      queryClient.query({ ...categoriesQuery, staleTime: 'static' }),
      queryClient.query({ ...savedSearchesQuery, staleTime: 'static' }),
      queryClient.query({ ...favoritesQuery, staleTime: 'static' }),
    ),
  head: ({ match }) => ({ meta: [{ title: `${pageTitle(toApiParams(match.search))} · faceslop` }] }),
  component: SearchPage,
});

function SearchPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const format = useFormat();
  const params = toApiParams(search);
  const results = useInfiniteQuery(searchQuery(params));
  const { data: categories } = useQuery(categoriesQuery);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const nearby = isNearbyBrowse(params);
  const categoryName =
    params.category === undefined ? null : (categories?.find((c) => c.slug === params.category)?.name ?? humanizeSlug(params.category));
  const pages = results.data?.pages ?? [];
  // The server de-duplicates within a session; this only guards React keys.
  const listings: readonly ListingSummary[] = [...new Map(pages.flatMap((p) => p.listings).map((l) => [l.id, l])).values()];
  const filteredCount = pages.reduce((n, p) => n + p.filteredCount, 0);
  const used = pages[0]?.location ?? null;
  // The location Facebook actually used wins over the name we asked with.
  const locationName = used?.name ?? search.locationName ?? null;
  const activeFilters = nearby ? 0 : countActiveFilters(params);
  const radius = params.radiusKm ?? used?.radiusKm ?? null;

  const title = params.query === undefined ? (categoryName ?? 'Today’s picks') : `“${params.query}”`;
  const where = [
    locationName === null ? 'Near your Facebook location' : `Near ${locationName}`,
    !nearby && radius !== null ? `within ${format.distanceKm(radius)}` : null,
  ]
    .filter((part) => part !== null)
    .join(' ');
  const { radiusKm: _radius, category: _category, ...rest } = params;
  const summary = nearby
    ? ''
    : describeSearch(params.query === undefined || params.category === undefined ? rest : { ...rest, category: params.category }, format, categoryName);
  // URL state only: results arriving (with the location Facebook used) must not reset a draft.
  const filterKey = `${searchIdentity(params)}|${search.locationName ?? ''}`;

  const apply = (next: SearchPageSearch) => {
    setFiltersOpen(false);
    void navigate({ search: next });
  };
  const refresh = () => {
    void queryClient.resetQueries({ queryKey: queryKeys.search(params), exact: true });
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {where}
            {summary !== '' && <span> · {summary}</span>}
          </p>
        </div>
        <div className="flex items-center gap-2 sm:ml-auto">
          <Button
            variant="outline"
            className="lg:hidden"
            onPress={() => {
              setFiltersOpen(true);
            }}
          >
            <SlidersHorizontal aria-hidden="true" />
            Filters
            {activeFilters > 0 && <span className="text-muted-foreground">({activeFilters})</span>}
          </Button>
          <SaveSearchButton params={params} defaultName={defaultSearchName(params, categoryName)} />
        </div>
      </header>

      {nearby && (
        <div className="mt-6">
          {/* A standing explanation, not an event: no live region. */}
          <Alert role="note">
            <Sparkles aria-hidden="true" />
            <AlertTitle>Today’s picks</AlertTitle>
            <AlertDescription>
              Facebook’s own selection for this area. It ignores filters, so search for something or pick a category to
              narrow it down.
            </AlertDescription>
          </Alert>
        </div>
      )}

      <div className="mt-8 lg:flex lg:gap-10">
        <aside aria-label="Filters" className="hidden lg:block lg:w-64 lg:shrink-0">
          {/* Scrolls on its own so "Apply filters" stays reachable beside a long grid. */}
          <div className="sticky top-24 max-h-sticky overflow-y-auto pr-1">
            <FilterPanel key={filterKey} surface="background" search={search} resolvedLocationName={locationName} onApply={apply} />
          </div>
        </aside>

        <section aria-labelledby="results-heading" aria-busy={results.isPending} className="min-w-0 flex-1">
          <h2 id="results-heading" className="sr-only">
            Results
          </h2>
          {results.isPending ? (
            <>
              <p role="status" className="mb-6 text-sm text-muted-foreground">
                Searching Marketplace. This takes a few seconds.
              </p>
              <ListingGridSkeleton layout="sidebar" count={12} />
            </>
          ) : results.isError && results.data === undefined ? (
            <ErrorState error={results.error} onRetry={refresh} retrying={results.isFetching} />
          ) : (
            <>
              {listings.length > 0 ? (
                <ListingGrid listings={listings} layout="sidebar" />
              ) : (
                <EmptyState icon={SearchX} title="No listings found">
                  {activeFilters > 0 ? 'Try loosening the filters or widening the distance.' : 'Try different words or a wider area.'}
                </EmptyState>
              )}
              {filteredCount > 0 && (
                <p className="mt-8 text-sm text-muted-foreground">
                  {format.plural(filteredCount, 'listing', 'listings')} hidden by your filters.{' '}
                  <Link to="/settings" className="rounded-sm text-primary hover:underline">
                    Review filters
                  </Link>
                </p>
              )}
              <ResultsFooter
                hasMore={results.hasNextPage}
                loadingMore={results.isFetchingNextPage}
                loadMoreError={results.isFetchNextPageError ? results.error : null}
                anyResults={listings.length > 0}
                onLoadMore={() => {
                  void results.fetchNextPage();
                }}
                onRefresh={refresh}
              />
            </>
          )}
        </section>
      </div>

      <Sheet isOpen={filtersOpen} onOpenChange={setFiltersOpen} side="right">
        <SheetHeader>
          <SheetTitle>Filters</SheetTitle>
        </SheetHeader>
        <div className="overflow-y-auto px-4">
          <FilterPanel key={filterKey} surface="popover" search={search} resolvedLocationName={locationName} onApply={apply} />
        </div>
      </Sheet>
    </div>
  );
}

interface ResultsFooterProps {
  readonly hasMore: boolean;
  readonly loadingMore: boolean;
  readonly loadMoreError: unknown;
  readonly anyResults: boolean;
  readonly onLoadMore: () => void;
  readonly onRefresh: () => void;
}

/** An explicit "Load more", never infinite scroll. */
function ResultsFooter({ hasMore, loadingMore, loadMoreError, anyResults, onLoadMore, onRefresh }: ResultsFooterProps) {
  if (loadMoreError !== null) {
    if (appErrorOf(loadMoreError)?.code === 'SESSION_EXPIRED') {
      return (
        <div className="mt-10 flex flex-col items-center gap-3 text-center">
          <p className="text-sm text-muted-foreground">These results have expired, so there’s no next page to fetch.</p>
          <Button onPress={onRefresh}>
            <RefreshCw aria-hidden="true" />
            Refresh results
          </Button>
        </div>
      );
    }
    return (
      <div className="mt-10">
        <ErrorState error={loadMoreError} onRetry={onLoadMore} retrying={loadingMore} />
      </div>
    );
  }
  if (hasMore) {
    return (
      <div className="mt-10 flex justify-center">
        <Button size="lg" variant="outline" isPending={loadingMore} onPress={onLoadMore}>
          {loadingMore ? 'Loading…' : 'Load more'}
        </Button>
      </div>
    );
  }
  if (!anyResults) return null;
  return <p className="mt-10 text-center text-sm text-muted-foreground">That’s everything for this search.</p>;
}
