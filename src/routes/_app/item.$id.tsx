import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, createFileRoute, useCanGoBack, useRouter } from '@tanstack/react-router';
import { ArrowLeft, Ban, EyeOff, MapPin, Truck } from 'lucide-react';
import { useEffect, type ReactNode } from 'react';
import { ErrorState } from '@/components/error-state';
import { FavoriteToggle } from '@/components/favorite-toggle';
import { useListingActions } from '@/components/listing-actions-menu';
import { PriceText, RelativeTime, StatusBadge } from '@/components/listing-bits';
import { ListingImage } from '@/components/listing-image';
import { MessagePanel } from '@/components/message-panel';
import { PhotoGallery } from '@/components/photo-gallery';
import { SellerCard } from '@/components/seller-card';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toSummary } from '@/hooks/mutations';
import { favoritesQuery, findCachedListing, listingQuery, settled } from '@/lib/queries';
import type { ListingDetail, ListingSummary } from '@/shared/domain';
import { appErrorOf } from '@/shared/errors';

export const Route = createFileRoute('/_app/item/$id')({
  // The listing itself comes from Facebook (seconds): fetched on the client, never on hover-preload.
  loader: ({ context: { queryClient } }) => settled(queryClient.query({ ...favoritesQuery, staleTime: 'static' })),
  head: () => ({ meta: [{ title: 'Listing · faceslop' }] }),
  component: ItemPage,
});

function ItemPage() {
  const { id } = Route.useParams();
  // Keyed so the gallery position, composer text, etc. reset when moving between listings.
  return <ItemView key={id} id={id} />;
}

function ItemView({ id }: { readonly id: string }) {
  const queryClient = useQueryClient();
  const listing = useQuery(listingQuery(id));
  const cached = listing.data === undefined ? findCachedListing(queryClient, id) : undefined;
  const title = listing.data?.title ?? cached?.title;

  // The browser tab follows the listing (an external system); the route's head only knows "Listing".
  useEffect(() => {
    document.title = title === undefined ? 'Listing · faceslop' : `${title} · faceslop`;
  }, [title]);

  let content;
  if (listing.data !== undefined) {
    content = <ListingView listing={listing.data} />;
  } else if (listing.isError) {
    content =
      appErrorOf(listing.error)?.code === 'NOT_FOUND' ? (
        <ErrorState error={listing.error} title="This listing isn’t available" />
      ) : (
        <ErrorState
          error={listing.error}
          onRetry={() => {
            void listing.refetch();
          }}
          retrying={listing.isFetching}
        />
      );
  } else {
    content = <ListingLoading cached={cached} />;
  }

  return (
    <div className="mx-auto max-w-6xl px-4 py-5 sm:px-6 sm:py-6">
      <BackLink />
      <div className="mt-4">{content}</div>
    </div>
  );
}

function BackLink() {
  const router = useRouter();
  const canGoBack = useCanGoBack();
  if (canGoBack) {
    return (
      <Button
        variant="ghost"
        size="sm"
        onPress={() => {
          router.history.back();
        }}
      >
        <ArrowLeft aria-hidden="true" />
        Back
      </Button>
    );
  }
  return (
    <Link to="/" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
      <ArrowLeft aria-hidden="true" />
      Home
    </Link>
  );
}

/** Two columns on wide screens: gallery + description on the left, a sticky summary on the right. */
function ItemLayout({ gallery, aside, details }: { readonly gallery: ReactNode; readonly aside: ReactNode; readonly details: ReactNode }) {
  return (
    <div className="flex flex-col gap-8 lg:flex-row lg:items-start lg:gap-10">
      <div className="flex min-w-0 flex-1 flex-col gap-8">
        {gallery}
        <div className="hidden lg:block">{details}</div>
      </div>
      <div className="flex flex-col gap-5 lg:sticky lg:top-24 lg:w-96 lg:shrink-0">{aside}</div>
      <div className="lg:hidden">{details}</div>
    </div>
  );
}

function ListingView({ listing }: { readonly listing: ListingDetail }) {
  const shipping = listing.shippingOffered || listing.deliveryTypes.includes('SHIPPING');
  const photos = listing.photos.length > 0 ? listing.photos : listing.imageUrl === null ? [] : [listing.imageUrl];

  return (
    <article>
      <ItemLayout
        gallery={<PhotoGallery photos={photos} title={listing.title} />}
        aside={
          <>
            <ListingHeading listing={listing} />
            <ul aria-label="About this listing" className="flex flex-wrap gap-2">
              {listing.condition !== null && (
                <li>
                  <Badge variant="outline">{listing.condition}</Badge>
                </li>
              )}
              {listing.categoryName !== null && (
                <li>
                  <Badge variant="outline">{listing.categoryName}</Badge>
                </li>
              )}
              <li>
                <Badge variant="outline">
                  {shipping && <Truck aria-hidden="true" />}
                  {shipping ? 'Shipping available' : 'Local pickup'}
                </Badge>
              </li>
            </ul>
            <ListingActions listing={listing} />
            <MessagePanel listing={listing} />
            {listing.seller !== null && <SellerCard seller={listing.seller} />}
          </>
        }
        details={<ListingDetails listing={listing} />}
      />
    </article>
  );
}

function ListingDetails({ listing }: { readonly listing: ListingDetail }) {
  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="item-description">
        <h2 id="item-description" className="mb-2 text-sm font-medium text-muted-foreground">
          Description
        </h2>
        {listing.description === '' ? (
          <p className="text-muted-foreground">The seller didn’t add a description.</p>
        ) : (
          <p className="max-w-prose leading-relaxed whitespace-pre-line">{listing.description}</p>
        )}
      </section>
      {listing.attributes.length > 0 && (
        <section aria-labelledby="item-details">
          <h2 id="item-details" className="mb-2 text-sm font-medium text-muted-foreground">
            Details
          </h2>
          <dl className="divide-y overflow-hidden rounded-xl bg-card text-sm ring-1 ring-foreground/10">
            {listing.attributes.map((attribute) => (
              <div key={`${attribute.label}:${attribute.value}`} className="flex gap-4 px-4 py-2.5">
                <dt className="w-2/5 shrink-0 text-muted-foreground">{attribute.label}</dt>
                <dd className="min-w-0">{attribute.value}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
    </div>
  );
}

function ListingHeading({ listing }: { readonly listing: ListingSummary }) {
  return (
    <div>
      <StatusBadge status={listing.status} className="mb-2" />
      <h1 className="text-2xl font-semibold tracking-tight text-balance">{listing.title}</h1>
      <p className="mt-2 flex flex-wrap items-baseline gap-x-2.5 tabular-nums">
        <span className="text-2xl font-semibold">
          <PriceText price={listing.price} />
        </span>
        {listing.previousPrice !== null && (
          <s className="text-muted-foreground">
            <span className="sr-only">was </span>
            {listing.previousPrice}
          </s>
        )}
      </p>
      {(listing.createdAt !== null || listing.location !== null) && (
        <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-sm text-muted-foreground">
          {listing.createdAt !== null && (
            <span>
              Listed <RelativeTime ms={listing.createdAt} />
            </span>
          )}
          {listing.createdAt !== null && listing.location !== null && <span aria-hidden="true">·</span>}
          {listing.location !== null && (
            <span className="inline-flex items-center gap-1">
              <MapPin className="size-3.5" aria-hidden="true" />
              {listing.location}
            </span>
          )}
        </p>
      )}
    </div>
  );
}

function ListingActions({ listing }: { readonly listing: ListingDetail }) {
  // Search results don't always carry the seller id; the full listing's seller does.
  const actions = useListingActions({
    ...toSummary(listing),
    sellerId: listing.sellerId ?? listing.seller?.id ?? null,
    sellerName: listing.sellerName ?? listing.seller?.name ?? null,
  });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <FavoriteToggle listing={listing} variant="labelled" />
      <Button variant="ghost" isPending={actions.hiding} onPress={actions.hideListing}>
        <EyeOff aria-hidden="true" />
        Hide
      </Button>
      {actions.canBlock && (
        <Button variant="ghost" isPending={actions.blocking} onPress={actions.blockSeller}>
          <Ban aria-hidden="true" />
          Block seller
        </Button>
      )}
    </div>
  );
}

/** While Facebook loads the full listing (a few seconds), show what search results already told us. */
function ListingLoading({ cached }: { readonly cached: ListingSummary | undefined }) {
  return (
    <div aria-busy="true">
      <p role="status" className="sr-only">
        Loading the listing
      </p>
      <ItemLayout
        gallery={
          cached === undefined ? (
            <Skeleton className="aspect-4/3 w-full" />
          ) : (
            <ListingImage src={cached.imageUrl} alt={cached.title} fit="contain" eager className="aspect-4/3 w-full rounded-xl" />
          )
        }
        aside={
          <>
            {cached === undefined ? (
              <div className="flex flex-col gap-3">
                <Skeleton className="h-7 w-4/5" />
                <Skeleton className="h-7 w-1/3" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ) : (
              <ListingHeading listing={cached} />
            )}
            <Skeleton className="h-9 w-2/3" />
            <Skeleton className="h-44 w-full" />
          </>
        }
        details={
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-11/12" />
            <Skeleton className="h-4 w-3/4" />
          </div>
        }
      />
    </div>
  );
}
