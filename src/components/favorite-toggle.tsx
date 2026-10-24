import { useQuery } from '@tanstack/react-query';
import { Heart } from 'lucide-react';
import { Toggle } from '@/components/ui/toggle';
import { useToggleFavorite } from '@/hooks/mutations';
import { favoritesQuery } from '@/lib/queries';
import type { ListingSummary } from '@/shared/domain';

export function useIsFavorite(listingId: string): boolean {
  const { data } = useQuery({ ...favoritesQuery, select: (list) => list.some((f) => f.listing.id === listingId) });
  return data ?? false;
}

interface FavoriteToggleProps {
  readonly listing: ListingSummary;
  /** "overlay" sits on a card photo; "labelled" is a regular button with text. */
  readonly variant?: 'overlay' | 'labelled';
}

/** Saves a listing to favorites (optimistically). */
export function FavoriteToggle({ listing, variant = 'overlay' }: FavoriteToggleProps) {
  const favorited = useIsFavorite(listing.id);
  const toggle = useToggleFavorite();
  const onChange = () => {
    toggle.mutate({ listing, favorited });
  };
  const icon = (
    <Heart
      aria-hidden="true"
      className="group-data-selected/toggle:fill-primary group-data-selected/toggle:text-primary"
    />
  );

  if (variant === 'labelled') {
    return (
      <Toggle variant="outline" isSelected={favorited} onChange={onChange}>
        {icon}
        {favorited ? 'Saved' : 'Save'}
      </Toggle>
    );
  }
  return (
    <span className="block rounded-md bg-background/90 shadow-xs backdrop-blur-sm">
      <Toggle
        size="sm"
        isSelected={favorited}
        onChange={onChange}
        aria-label={favorited ? `Remove “${listing.title}” from favorites` : `Save “${listing.title}” to favorites`}
      >
        {icon}
      </Toggle>
    </span>
  );
}
