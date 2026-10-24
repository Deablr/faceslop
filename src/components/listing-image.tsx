import { ImageOff } from 'lucide-react';
import { useState } from 'react';
import { cn } from '@/lib/utils';

interface ListingImageProps {
  readonly src: string | null;
  readonly alt: string;
  readonly className?: string;
  /** "contain" for the gallery, "cover" for cards and thumbnails. */
  readonly fit?: 'cover' | 'contain';
  readonly eager?: boolean;
}

/** A Facebook CDN photo: no referrer, lazy by default, a quiet placeholder when missing or broken. */
export function ListingImage({ src, alt, className, fit = 'cover', eager = false }: ListingImageProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  if (src === null || failedSrc === src) {
    return (
      <div
        role="img"
        aria-label={alt === '' ? 'No photo' : alt}
        className={cn('flex items-center justify-center bg-muted text-muted-foreground', className)}
      >
        <ImageOff className="size-6" strokeWidth={1.5} aria-hidden="true" />
      </div>
    );
  }
  return (
    <img
      // A server-rendered image that failed before hydration (e.g. an expired Facebook CDN URL on
      // an old favorite) never fires onError, so check once it's attached.
      ref={(img) => {
        if (img?.complete === true && img.naturalWidth === 0) setFailedSrc(src);
      }}
      src={src}
      alt={alt}
      loading={eager ? 'eager' : 'lazy'}
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => {
        setFailedSrc(src);
      }}
      className={cn('bg-muted', fit === 'cover' ? 'object-cover' : 'object-contain', className)}
    />
  );
}
