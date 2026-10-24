import { useQuery } from '@tanstack/react-query';
import { ErrorState, InlineError } from '@/components/error-state';
import { RelativeTime } from '@/components/listing-bits';
import { SettingsSection } from '@/components/settings/settings-section';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { useClearHidden, useUnblockSeller } from '@/hooks/mutations';
import { useFormat } from '@/hooks/use-format';
import { blockedSellersQuery, hiddenQuery } from '@/lib/queries';

export function BlockedSellersSection() {
  const blocked = useQuery(blockedSellersQuery);
  const unblock = useUnblockSeller();
  return (
    <SettingsSection title="Blocked sellers" description="Their listings never appear in your results.">
      {blocked.isPending ? (
        <Skeleton className="h-14 w-full" />
      ) : blocked.isError ? (
        <ErrorState
          error={blocked.error}
          onRetry={() => {
            void blocked.refetch();
          }}
        />
      ) : blocked.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nobody blocked. Use “Block seller” on a listing to stop seeing someone.</p>
      ) : (
        <ItemGroup>
          {blocked.data.map((seller) => (
            <Item key={seller.id} variant="muted" size="sm">
              <ItemContent>
                <ItemTitle>{seller.name === '' ? 'Unknown seller' : seller.name}</ItemTitle>
                <ItemDescription>
                  Blocked <RelativeTime ms={seller.blockedAt} />
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Button
                  variant="outline"
                  size="sm"
                  isPending={unblock.isPending && unblock.variables === seller.id}
                  onPress={() => {
                    unblock.mutate(seller.id);
                  }}
                >
                  Unblock
                </Button>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
      <InlineError error={unblock.error} />
    </SettingsSection>
  );
}

export function HiddenListingsSection() {
  const hidden = useQuery(hiddenQuery);
  const clear = useClearHidden();
  const format = useFormat();
  const count = hidden.data?.length ?? 0;

  return (
    <SettingsSection title="Hidden listings" description="Listings you hid with “Hide listing”.">
      {hidden.isPending ? (
        <Skeleton className="h-9 w-full" />
      ) : hidden.isError ? (
        <ErrorState
          error={hidden.error}
          onRetry={() => {
            void hidden.refetch();
          }}
        />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-muted-foreground">
            {count === 0 ? 'Nothing hidden.' : `${format.plural(count, 'listing', 'listings')} hidden.`}
          </p>
          {count > 0 && (
            <AlertDialogTrigger>
              <Button variant="outline" size="sm">
                Clear all
              </Button>
              <AlertDialog size="sm">
                <AlertDialogHeader>
                  <AlertDialogTitle>Show hidden listings again?</AlertDialogTitle>
                  <AlertDialogDescription>They can turn up in new searches again.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <Button
                    variant="destructive"
                    slot="close"
                    onPress={() => {
                      clear.mutate();
                    }}
                  >
                    Clear all
                  </Button>
                </AlertDialogFooter>
              </AlertDialog>
            </AlertDialogTrigger>
          )}
        </div>
      )}
      <InlineError error={clear.error} />
    </SettingsSection>
  );
}
