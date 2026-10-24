import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type { KeyboardEvent } from 'react-aria-components';
import { ListingImage } from '@/components/listing-image';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface PhotoGalleryProps {
  readonly photos: readonly string[];
  readonly title: string;
}

/**
 * One photo at a time with thumbnails; no autoplay. Arrow keys, Home and End move between photos
 * while any of its buttons has focus. Remount (key) per listing.
 */
export function PhotoGallery({ photos, title }: PhotoGalleryProps) {
  const [index, setIndex] = useState(0);
  const count = photos.length;
  const current = Math.min(index, Math.max(count - 1, 0));
  const src = photos[current];

  if (src === undefined) {
    return <ListingImage src={null} alt={`No photos of ${title}`} className="aspect-4/3 w-full rounded-xl" />;
  }

  const go = (i: number) => {
    setIndex((i + count) % count);
  };
  const keyTargets: Readonly<Record<string, number>> = { ArrowLeft: current - 1, ArrowRight: current + 1, Home: 0, End: count - 1 };
  const onKeyDown = (e: KeyboardEvent) => {
    const target = keyTargets[e.key];
    if (target === undefined) {
      e.continuePropagation();
      return;
    }
    e.preventDefault();
    go(target);
  };

  return (
    <section aria-roledescription="carousel" aria-label={`Photos of ${title}`} className="flex flex-col gap-3">
      <div className="relative overflow-hidden rounded-xl bg-muted">
        <ListingImage
          key={src}
          src={src}
          alt={count > 1 ? `${title}, photo ${String(current + 1)} of ${String(count)}` : title}
          fit="contain"
          eager
          className="aspect-4/3 w-full"
        />
        {count > 1 && (
          <>
            <Button
              // Solid in both themes: a translucent outline button disappears over a bright photo in dark mode.
              variant="secondary"
              size="icon"
              aria-label="Previous photo"
              className="absolute top-1/2 left-3 -translate-y-1/2"
              onKeyDown={onKeyDown}
              onPress={() => {
                go(current - 1);
              }}
            >
              <ChevronLeft aria-hidden="true" />
            </Button>
            <Button
              // Solid in both themes: a translucent outline button disappears over a bright photo in dark mode.
              variant="secondary"
              size="icon"
              aria-label="Next photo"
              className="absolute top-1/2 right-3 -translate-y-1/2"
              onKeyDown={onKeyDown}
              onPress={() => {
                go(current + 1);
              }}
            >
              <ChevronRight aria-hidden="true" />
            </Button>
            <p aria-live="polite" className="absolute right-3 bottom-3 rounded-full bg-background/85 px-2.5 py-0.5 text-xs tabular-nums backdrop-blur-sm">
              {current + 1} / {count}
            </p>
          </>
        )}
      </div>
      {count > 1 && (
        <ul className="flex gap-2 overflow-x-auto pb-1" aria-label="Choose a photo">
          {photos.map((photo, i) => (
            <li key={photo} className="shrink-0">
              <Button
                variant="ghost"
                size="icon-lg"
                className="size-16"
                aria-label={`Photo ${String(i + 1)}`}
                aria-current={i === current ? 'true' : undefined}
                onKeyDown={onKeyDown}
                onPress={() => {
                  setIndex(i);
                }}
              >
                <ListingImage
                  src={photo}
                  alt=""
                  className={cn('size-full rounded-md', i === current ? 'ring-2 ring-primary' : 'opacity-70')}
                />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
