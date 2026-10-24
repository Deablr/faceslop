import { Link } from '@tanstack/react-router';
import { TrendingDown } from 'lucide-react';
import { PriceText, RelativeTime, StatusBadge } from '@/components/listing-bits';
import { ListingImage } from '@/components/listing-image';
import { Button } from '@/components/ui/button';
import { Item, ItemActions, ItemContent, ItemMedia } from '@/components/ui/item';
import { useToggleFavorite } from '@/hooks/mutations';
import { useFormat } from '@/hooks/use-format';
import { cn } from '@/lib/utils';
import type { Favorite } from '@/shared/domain';

/** How much cheaper it is than when it was favorited, or null. */
function priceDrop({ listing, originalPrice }: Favorite): number | null {
  const now = listing.price.amount;
  const then = originalPrice.amount;
  return now !== null && then !== null && now < then ? then - now : null;
}

export function FavoriteRow({ favorite }: { readonly favorite: Favorite }) {
  const { listing, originalPrice, savedAt } = favorite;
  const format = useFormat();
  const toggle = useToggleFavorite();
  const drop = priceDrop(favorite);
  const sold = listing.status === 'sold';

  return (
    <li>
      <Item variant="outline">
        <ItemMedia>
          <Link to="/item/$id" params={{ id: listing.id }} tabIndex={-1} aria-hidden="true" className="block overflow-hidden rounded-lg">
            <ListingImage src={listing.imageUrl} alt="" className={cn('size-16 sm:size-20', sold && 'opacity-60 grayscale')} />
          </Link>
        </ItemMedia>
        <ItemContent className="min-w-0">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 tabular-nums">
            <span className="font-semibold">
              <PriceText price={listing.price} />
            </span>
            {drop !== null && (
              <>
                <s className="text-sm text-muted-foreground">
                  <span className="sr-only">was </span>
                  <PriceText price={originalPrice} />
                </s>
                <span className="inline-flex items-center gap-1 text-xs font-medium text-success">
                  <TrendingDown className="size-3.5" aria-hidden="true" />
                  {format.money(drop, listing.price.currency ?? originalPrice.currency ?? 'USD')} less
                </span>
              </>
            )}
            <StatusBadge status={listing.status} />
          </p>
          <Link to="/item/$id" params={{ id: listing.id }} className="truncate rounded-sm text-sm hover:underline">
            {listing.title}
          </Link>
          <p className="flex min-w-0 gap-1 text-xs text-muted-foreground">
            {listing.location !== null && (
              <>
                <span className="truncate">{listing.location}</span>
                <span aria-hidden="true">·</span>
              </>
            )}
            <span className="shrink-0">
              Saved <RelativeTime ms={savedAt} />
            </span>
          </p>
        </ItemContent>
        <ItemActions>
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Remove “${listing.title}” from favorites`}
            onPress={() => {
              toggle.mutate({ listing, favorited: true });
            }}
          >
            Remove
          </Button>
        </ItemActions>
      </Item>
    </li>
  );
}
