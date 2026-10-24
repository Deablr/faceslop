import { Link } from '@tanstack/react-router';
import { FavoriteToggle } from '@/components/favorite-toggle';
import { ListingActionsMenu } from '@/components/listing-actions-menu';
import { PriceText, RelativeTime, StatusBadge } from '@/components/listing-bits';
import { ListingImage } from '@/components/listing-image';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { ListingSummary } from '@/shared/domain';

export function ListingCard({ listing }: { readonly listing: ListingSummary }) {
  const sold = listing.status === 'sold';
  return (
    <article className="group flex min-w-0 flex-col">
      <div className="relative">
        {/* The title link below is the accessible one; the photo is a pointer shortcut. */}
        <Link
          to="/item/$id"
          params={{ id: listing.id }}
          tabIndex={-1}
          aria-hidden="true"
          className="block overflow-hidden rounded-xl bg-muted"
        >
          <ListingImage
            src={listing.imageUrl}
            alt=""
            className={cn(
              'aspect-square w-full transition-transform duration-300 motion-safe:group-hover:scale-103',
              sold && 'opacity-60 grayscale',
            )}
          />
        </Link>
        <StatusBadge status={listing.status} className="absolute top-2 left-2" />
        <div className="absolute top-2 right-2">
          <FavoriteToggle listing={listing} />
        </div>
      </div>
      <div className="mt-2.5 flex items-start gap-1">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2 tabular-nums">
            <span className="font-semibold">
              <PriceText price={listing.price} />
            </span>
            {listing.previousPrice !== null && (
              <s className="text-sm text-muted-foreground">
                <span className="sr-only">was </span>
                {listing.previousPrice}
              </s>
            )}
          </p>
          <h3 className="mt-0.5 line-clamp-2 text-sm leading-snug">
            <Link to="/item/$id" params={{ id: listing.id }} className="rounded-sm hover:underline">
              {listing.title}
            </Link>
          </h3>
          <ListingMeta listing={listing} />
        </div>
        <ListingActionsMenu listing={listing} />
      </div>
    </article>
  );
}

function ListingMeta({ listing }: { readonly listing: ListingSummary }) {
  if (listing.location === null && listing.createdAt === null) return null;
  return (
    <p className="mt-1 flex min-w-0 gap-1 text-xs text-muted-foreground">
      {listing.location !== null && <span className="truncate">{listing.location}</span>}
      {listing.location !== null && listing.createdAt !== null && <span aria-hidden="true">·</span>}
      {listing.createdAt !== null && (
        <span className="shrink-0">
          <RelativeTime ms={listing.createdAt} />
        </span>
      )}
    </p>
  );
}

type GridLayout = 'wide' | 'sidebar';

export function ListingGrid({ listings, layout = 'wide' }: { readonly listings: readonly ListingSummary[]; readonly layout?: GridLayout }) {
  return (
    <ul
      className={cn(
        'grid grid-cols-2 gap-x-4 gap-y-8',
        layout === 'wide' ? 'sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5' : 'sm:grid-cols-3 xl:grid-cols-4',
      )}
    >
      {listings.map((listing) => (
        <li key={listing.id} className="min-w-0">
          <ListingCard listing={listing} />
        </li>
      ))}
    </ul>
  );
}

const SKELETON_KEYS = Array.from({ length: 12 }, (_, i) => `skeleton-${String(i)}`);

export function ListingGridSkeleton({ count = 10, layout = 'wide' }: { readonly count?: number; readonly layout?: GridLayout }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'grid grid-cols-2 gap-x-4 gap-y-8',
        layout === 'wide' ? 'sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5' : 'sm:grid-cols-3 xl:grid-cols-4',
      )}
    >
      {SKELETON_KEYS.slice(0, count).map((key) => (
        <div key={key}>
          <Skeleton className="aspect-square w-full" />
          <Skeleton className="mt-3 h-4 w-1/3" />
          <Skeleton className="mt-2 h-3.5 w-5/6" />
          <Skeleton className="mt-2 h-3 w-1/2" />
        </div>
      ))}
    </div>
  );
}
