import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { Bookmark, Heart } from 'lucide-react';
import { EmptyState } from '@/components/empty-state';
import { ErrorState } from '@/components/error-state';
import { FavoriteRow } from '@/components/favorite-row';
import { LocalDataNote } from '@/components/local-data-note';
import { SavedSearchRow, SavedSearchRun } from '@/components/saved-searches';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { categoriesQuery, favoritesQuery, savedSearchesQuery, settled } from '@/lib/queries';

export interface SavedPageSearch {
  /** Saved search whose new listings are shown ("View new"). */
  readonly view?: number;
}

export function validateSavedSearch(raw: Readonly<Record<string, unknown>>): SavedPageSearch {
  const view = Number(raw.view);
  return Number.isInteger(view) && view > 0 ? { view } : {};
}

export const Route = createFileRoute('/_app/saved')({
  validateSearch: validateSavedSearch,
  loader: ({ context: { queryClient } }) =>
    settled(
      queryClient.query({ ...savedSearchesQuery, staleTime: 'static' }),
      queryClient.query({ ...favoritesQuery, staleTime: 'static' }),
      queryClient.query({ ...categoriesQuery, staleTime: 'static' }),
    ),
  head: () => ({ meta: [{ title: 'Saved · faceslop' }] }),
  component: SavedPage,
});

function SavedPage() {
  const { view } = Route.useSearch();
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-12 px-4 py-6 sm:px-6 sm:py-8">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight">Saved</h1>
        <LocalDataNote what="Saved searches and favorites" />
      </div>
      {view !== undefined && <SavedSearchRun key={view} id={view} />}
      <SavedSearchesSection />
      <FavoritesSection />
    </div>
  );
}

function SavedSearchesSection() {
  const saved = useQuery(savedSearchesQuery);
  const { data: categories } = useQuery(categoriesQuery);
  const categoryName = (slug: string | undefined) =>
    slug === undefined ? null : (categories?.find((c) => c.slug === slug)?.name ?? null);

  return (
    <section aria-labelledby="saved-searches">
      <h2 id="saved-searches" className="mb-3 text-base font-semibold tracking-tight">
        Saved searches
      </h2>
      {saved.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : saved.isError ? (
        <ErrorState
          error={saved.error}
          onRetry={() => {
            void saved.refetch();
          }}
          retrying={saved.isFetching}
        />
      ) : saved.data.length === 0 ? (
        <EmptyState
          icon={Bookmark}
          title="No saved searches yet"
          action={
            <Link to="/" className={buttonVariants({ variant: 'outline' })}>
              Start a search
            </Link>
          }
        >
          Run a search and choose “Save search”. faceslop can check it quietly in the background and tell you what’s
          new, so there’s no need to keep looking.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {saved.data.map((s) => (
            <SavedSearchRow key={s.id} saved={s} categoryName={categoryName(s.params.category)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function FavoritesSection() {
  const favorites = useQuery(favoritesQuery);
  return (
    <section aria-labelledby="favorites-heading" id="favorites" className="scroll-mt-24">
      <h2 id="favorites-heading" className="mb-3 text-base font-semibold tracking-tight">
        Favorites
      </h2>
      {favorites.isPending ? (
        <Skeleton className="h-40 w-full" />
      ) : favorites.isError ? (
        <ErrorState
          error={favorites.error}
          onRetry={() => {
            void favorites.refetch();
          }}
          retrying={favorites.isFetching}
        />
      ) : favorites.data.length === 0 ? (
        <EmptyState icon={Heart} title="No favorites yet">
          Tap the heart on any listing to keep it here. You’ll see when the price drops or it sells.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-3">
          {favorites.data.map((f) => (
            <FavoriteRow key={f.listing.id} favorite={f} />
          ))}
        </ul>
      )}
    </section>
  );
}
