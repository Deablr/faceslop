import { Star } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from '@/components/ui/item';
import { useFormat } from '@/hooks/use-format';
import type { SellerInfo } from '@/shared/domain';

export function SellerCard({ seller }: { readonly seller: SellerInfo }) {
  const format = useFormat();
  return (
    <Item variant="outline">
      <ItemMedia>
        <Avatar size="lg">
          {seller.avatarUrl !== null && <AvatarImage src={seller.avatarUrl} alt="" referrerPolicy="no-referrer" />}
          <AvatarFallback>{seller.name.charAt(0).toUpperCase() || '?'}</AvatarFallback>
        </Avatar>
      </ItemMedia>
      <ItemContent>
        <p className="text-xs text-muted-foreground">Seller</p>
        <ItemTitle>{seller.name}</ItemTitle>
        {seller.rating !== null && (
          <ItemDescription>
            <span className="inline-flex items-center gap-1">
              <Star className="size-3.5 fill-current text-warning" aria-hidden="true" />
              {seller.rating.toFixed(1)}
              <span className="sr-only"> out of 5</span>
              {seller.ratingCount !== null && <span> · {format.plural(seller.ratingCount, 'rating', 'ratings')}</span>}
            </span>
          </ItemDescription>
        )}
        {seller.joinedText !== null && <ItemDescription>{seller.joinedText}</ItemDescription>}
      </ItemContent>
    </Item>
  );
}
