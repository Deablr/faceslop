import { useQuery } from '@tanstack/react-query';
import { Link, createFileRoute } from '@tanstack/react-router';
import { ArrowRight, MapPin } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { PriceText } from '@/components/listing-bits';
import { ListingImage } from '@/components/listing-image';
import { ViewNewLink, useSearchSummary } from '@/components/saved-searches';
import { SearchBox } from '@/components/search-box';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { categoriesQuery, favoritesQuery, savedSearchesQuery, settingsQuery, settled } from '@/lib/queries';
import { withSearchDefaults } from '@/lib/search-params';
import type { Category, Favorite, SavedSearch } from '@/shared/domain';

export const Route = createFileRoute('/_app/')({
  loader: ({ context: { queryClient } }) =>
    settled(
      queryClient.query({ ...categoriesQuery, staleTime: 'static' }),
      queryClient.query({ ...savedSearchesQuery, staleTime: 'static' }),
      queryClient.query({ ...favoritesQuery, staleTime: 'static' }),
    ),
  component: HomePage,
});

const CHIP_LIMIT = 10;
const CHIP_SKELETONS = ['a', 'b', 'c', 'd', 'e', 'f'];

/** Intent first: a search box, a few ways in, and what you already saved. No feed. */
function HomePage() {
  const { data: settings } = useQuery(settingsQuery);
  return (
    <div className="mx-auto max-w-3xl px-4 pt-12 sm:px-6 sm:pt-24">
      <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">What are you looking for?</h1>
      <p className="mt-2 text-muted-foreground">Marketplace, without the rest of Facebook. Find it, then get on with your day.</p>
      <div className="mt-8">
        <SearchBox size="lg" />
      </div>
      <CategoryChips />
      <Link
        to="/search"
        search={withSearchDefaults({}, settings)}
        className="mt-6 inline-flex items-center gap-1.5 rounded-sm text-sm text-primary hover:underline"
      >
        <MapPin className="size-4" aria-hidden="true" />
        Browse nearby
        {settings?.defaultLocation ? <span className="text-muted-foreground">· {settings.defaultLocation.name}</span> : null}
      </Link>
      <div className="mt-16 flex flex-col gap-12">
        <SavedSearchesSummary />
        <FavoritesPreview />
      </div>
    </div>
  );
}

function CategoryChips() {
  const { data: settings } = useQuery(settingsQuery);
  const categories = useQuery(categoriesQuery);
  const [showAll, setShowAll] = useState(false);
  if (categories.isError) return null;
  if (categories.isPending) {
    return (
      <div className="mt-6 flex flex-wrap gap-2" aria-hidden="true">
        {CHIP_SKELETONS.map((key) => (
          <Skeleton key={key} className="h-8 w-24" />
        ))}
      </div>
    );
  }
  const visible: readonly Category[] = showAll ? categories.data : categories.data.slice(0, CHIP_LIMIT);
  return (
    <ul className="mt-6 flex flex-wrap gap-2" aria-label="Categories">
      {visible.map((category) => (
        <li key={category.slug}>
          <Link
            to="/search"
            search={withSearchDefaults({ category: category.slug }, settings)}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            {category.name}
          </Link>
        </li>
      ))}
      {categories.data.length > CHIP_LIMIT && (
        <li>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={showAll}
            onPress={() => {
              setShowAll((s) => !s);
            }}
          >
            {showAll ? 'Fewer' : `${String(categories.data.length - CHIP_LIMIT)} more`}
          </Button>
        </li>
      )}
    </ul>
  );
}

function SectionHeading({ id, title, children }: { readonly id: string; readonly title: string; readonly children: ReactNode }) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-4">
      <h2 id={id} className="text-sm font-medium text-muted-foreground">
        {title}
      </h2>
      {children}
    </div>
  );
}

function SavedSearchesSummary() {
  const { data, isPending, isError } = useQuery(savedSearchesQuery);
  const { data: categories } = useQuery(categoriesQuery);
  if (isError || data?.length === 0) return null;
  return (
    <section aria-labelledby="home-saved">
      <SectionHeading id="home-saved" title="Saved searches">
        <Link to="/saved" className="rounded-sm text-sm text-primary hover:underline">
          Manage
        </Link>
      </SectionHeading>
      {isPending ? (
        <Skeleton className="h-28 w-full" />
      ) : (
        <ul className="divide-y overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
          {data.slice(0, 6).map((saved) => (
            <SavedSearchLine
              key={saved.id}
              saved={saved}
              categoryName={categories?.find((c) => c.slug === saved.params.category)?.name ?? null}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function SavedSearchLine({ saved, categoryName }: { readonly saved: SavedSearch; readonly categoryName: string | null }) {
  const summary = useSearchSummary(saved, categoryName);
  return (
    <li>
      <ViewNewLink
        savedSearchId={saved.id}
        className="flex items-center gap-4 px-4 py-3 transition-colors hover:bg-muted/60 focus-visible:-outline-offset-2"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{saved.name}</span>
          <span className="block truncate text-xs text-muted-foreground">{summary}</span>
        </span>
        {saved.newCount > 0 ? (
          <span className="shrink-0 text-sm text-primary">{saved.newCount} new</span>
        ) : (
          <span className="shrink-0 text-sm text-muted-foreground">Nothing new</span>
        )}
        <ArrowRight className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      </ViewNewLink>
    </li>
  );
}

function FavoritesPreview() {
  const { data, isError } = useQuery(favoritesQuery);
  if (isError || data === undefined || data.length === 0) return null;
  return (
    <section aria-labelledby="home-favorites">
      <SectionHeading id="home-favorites" title="Favorites">
        <Link to="/saved" hash="favorites" className="rounded-sm text-sm text-primary hover:underline">
          All {data.length}
        </Link>
      </SectionHeading>
      <ul className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        {data.slice(0, 4).map((favorite) => (
          <FavoriteTile key={favorite.listing.id} favorite={favorite} />
        ))}
      </ul>
    </section>
  );
}

function FavoriteTile({ favorite: { listing } }: { readonly favorite: Favorite }) {
  return (
    <li className="min-w-0">
      <Link to="/item/$id" params={{ id: listing.id }} className="group block rounded-xl">
        <ListingImage src={listing.imageUrl} alt="" className="aspect-square w-full rounded-xl" />
        <span className="mt-2 block text-sm font-semibold tabular-nums">
          <PriceText price={listing.price} />
        </span>
        <span className="block truncate text-sm text-muted-foreground group-hover:underline">{listing.title}</span>
      </Link>
    </li>
  );
}
