// Small pieces shared by cards, rows and the item page.
import { Badge } from '@/components/ui/badge';
import { useFormat, useNow } from '@/hooks/use-format';
import type { ListingStatus, Price } from '@/shared/domain';

/** Only sold/pending get a badge; available is the unremarkable default. */
export function StatusBadge({ status, className }: { readonly status: ListingStatus; readonly className?: string }) {
  if (status === 'sold') {
    return (
      <Badge variant="secondary" className={className}>
        Sold
      </Badge>
    );
  }
  if (status === 'pending') {
    return (
      <Badge variant="secondary" className={className}>
        Pending
      </Badge>
    );
  }
  return null;
}

/** "3 hours ago" with the exact time on hover. Empty until hydrated (the clock is client-only). */
export function RelativeTime({ ms }: { readonly ms: number }) {
  const format = useFormat();
  const now = useNow();
  return (
    <time dateTime={new Date(ms).toISOString()} title={now === null ? undefined : format.dateTime(ms)}>
      {now === null ? '' : format.relativeTime(ms, now)}
    </time>
  );
}

export function PriceText({ price }: { readonly price: Price }) {
  const format = useFormat();
  return <>{format.price(price)}</>;
}
