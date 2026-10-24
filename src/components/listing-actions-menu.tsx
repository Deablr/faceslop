import { Ban, Ellipsis, EyeOff } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useBlockSeller, useHideListing, useUnblockSeller, useUnhideListing } from '@/hooks/mutations';
import type { ListingSummary } from '@/shared/domain';
import { toClientError } from '@/shared/errors';

/** Hide a listing or block its seller, with a quiet undo. Shared by the card menu and the item page. */
export function useListingActions(listing: ListingSummary) {
  const hide = useHideListing();
  const unhide = useUnhideListing();
  const block = useBlockSeller();
  const unblock = useUnblockSeller();
  const sellerName = listing.sellerName ?? 'this seller';

  const hideListing = () => {
    hide.mutate(
      { id: listing.id, title: listing.title },
      {
        onSuccess: () => {
          toast('Listing hidden', {
            description: "It won't show up in your results again.",
            action: {
              label: 'Undo',
              onClick: () => {
                unhide.mutate(listing.id);
              },
            },
          });
        },
        onError: (error) => {
          toast.error("Couldn't hide that listing", { description: toClientError(error).message });
        },
      },
    );
  };

  const blockSeller = () => {
    const sellerId = listing.sellerId;
    if (sellerId === null) return;
    block.mutate(
      { id: sellerId, name: listing.sellerName ?? 'Unknown seller' },
      {
        onSuccess: () => {
          toast(`Blocked ${sellerName}`, {
            description: 'Their listings are left out of your results.',
            action: {
              label: 'Undo',
              onClick: () => {
                unblock.mutate(sellerId);
              },
            },
          });
        },
        onError: (error) => {
          toast.error(`Couldn't block ${sellerName}`, { description: toClientError(error).message });
        },
      },
    );
  };

  return { hideListing, blockSeller, hiding: hide.isPending, blocking: block.isPending, canBlock: listing.sellerId !== null };
}

/** Overflow menu on a listing card. */
export function ListingActionsMenu({ listing }: { readonly listing: ListingSummary }) {
  const actions = useListingActions(listing);
  return (
    <DropdownMenuTrigger>
      <Button variant="ghost" size="icon-sm" aria-label={`More actions for “${listing.title}”`}>
        <Ellipsis aria-hidden="true" />
      </Button>
      <DropdownMenu placement="bottom end" className="min-w-48">
        <DropdownMenuItem onAction={actions.hideListing} isDisabled={actions.hiding}>
          <EyeOff aria-hidden="true" />
          Hide listing
        </DropdownMenuItem>
        {actions.canBlock && (
          <DropdownMenuItem onAction={actions.blockSeller} isDisabled={actions.blocking}>
            <Ban aria-hidden="true" />
            {listing.sellerName === null ? 'Block seller' : `Block ${listing.sellerName}`}
          </DropdownMenuItem>
        )}
      </DropdownMenu>
    </DropdownMenuTrigger>
  );
}
