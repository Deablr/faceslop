// Makes extractor output satisfy the domain schemas in src/shared/domain.ts. Pure.
//
// Facebook's payloads are untrusted: a title can be longer than ListingSummary allows, an image
// "URL" can be a data: URI, a seller id can carry characters FbId rejects. Anything the extractor
// emits ends up in server-function responses, favorites and saved-search rows, which are decoded
// with those schemas (e.g. FavoriteInput), so a non-conforming listing would surface later as a
// confusing BAD_REQUEST. Each conform* function repairs what can be repaired (clip long text, null
// out invalid optional fields) and then decodes the result with the domain schema itself, so the
// guarantee is the schema's, not a copy of its rules. What can't be repaired (no numeric id) is
// dropped (null). Never throws.
import '@tanstack/react-start/server-only';
import { Option, Schema } from 'effect';
import {
  FbId,
  HttpUrl,
  ListingDetail,
  ListingId,
  ListingSummary,
  LocationId,
  LocationOption,
  type Price,
  type SellerInfo,
} from '@/shared/domain';

/** Text limits of ListingSummary (domain.ts `Text(n)`); longer values are clipped. */
const MAX = {
  title: 500,
  location: 200,
  sellerName: 200,
  formattedPrice: 100,
  currency: 10,
  deliveryType: 50,
  deliveryTypes: 10,
  categoryId: 64,
} as const;

const isListingId = Schema.is(ListingId);
const isFbId = Schema.is(FbId);
const isHttpUrl = Schema.is(HttpUrl);
const isLocationId = Schema.is(LocationId);
const decodeSummary = Schema.decodeUnknownOption(ListingSummary);
const decodeDetail = Schema.decodeUnknownOption(ListingDetail);
const decodeLocation = Schema.decodeUnknownOption(LocationOption);

/** `s`, or its first `max - 1` characters plus an ellipsis. */
export const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);
const clipOrNull = (s: string | null, max: number): string | null => (s === null ? null : clip(s, max));
const shortOrNull = (s: string | null, max: number): string | null => (s !== null && s.length <= max ? s : null);
const urlOrNull = (s: string | null): string | null => (s !== null && isHttpUrl(s) ? s : null);
const finiteOrNull = (n: number | null): number | null => (n !== null && Number.isFinite(n) ? n : null);
const nonNegativeOrNull = (n: number | null): number | null => (n !== null && Number.isFinite(n) && n >= 0 ? n : null);
const countOrNull = (n: number | null): number | null => (n !== null && Number.isInteger(n) && n >= 0 ? n : null);

function conformPrice(price: Price): Price {
  return {
    amount: nonNegativeOrNull(price.amount),
    formatted: clip(price.formatted, MAX.formattedPrice),
    currency: shortOrNull(price.currency, MAX.currency),
  };
}

/** A listing that satisfies the ListingSummary schema, or null when it has no numeric id. */
export function conformSummary(listing: ListingSummary): ListingSummary | null {
  if (!isListingId(listing.id)) return null;
  return Option.getOrNull(
    decodeSummary({
      id: listing.id,
      title: clip(listing.title, MAX.title),
      price: conformPrice(listing.price),
      previousPrice: clipOrNull(listing.previousPrice, MAX.formattedPrice),
      imageUrl: urlOrNull(listing.imageUrl),
      location: clipOrNull(listing.location, MAX.location),
      createdAt: finiteOrNull(listing.createdAt),
      status: listing.status,
      sellerId: listing.sellerId !== null && isFbId(listing.sellerId) ? listing.sellerId : null,
      sellerName: clipOrNull(listing.sellerName, MAX.sellerName),
      deliveryTypes: listing.deliveryTypes
        .filter((type) => type.length > 0 && type.length <= MAX.deliveryType)
        .slice(0, MAX.deliveryTypes),
      categoryId: shortOrNull(listing.categoryId, MAX.categoryId),
      url: listing.url,
    }),
  );
}

function conformSeller(seller: SellerInfo | null): SellerInfo | null {
  if (seller === null) return null;
  return {
    ...seller,
    avatarUrl: urlOrNull(seller.avatarUrl),
    rating: finiteOrNull(seller.rating),
    ratingCount: countOrNull(seller.ratingCount),
  };
}

/** A listing detail that satisfies the ListingDetail schema, or null when it has no numeric id. */
export function conformDetail(detail: ListingDetail): ListingDetail | null {
  const summary = conformSummary(detail);
  if (summary === null) return null;
  // Photos end up in <img src>: http(s) only.
  const photos = detail.photos.filter((photo) => isHttpUrl(photo));
  return Option.getOrNull(
    decodeDetail({
      ...summary,
      imageUrl: summary.imageUrl ?? photos[0] ?? null,
      description: detail.description,
      photos,
      condition: detail.condition,
      attributes: detail.attributes,
      categoryName: detail.categoryName,
      seller: conformSeller(detail.seller),
      shippingOffered: detail.shippingOffered,
      canMessage: detail.canMessage,
      hasMessaged: detail.hasMessaged,
      isViewerSeller: detail.isViewerSeller,
    }),
  );
}

/** A location option whose id is usable as SearchParams.location, or null. */
export function conformLocation(option: LocationOption): LocationOption | null {
  if (!isLocationId(option.id)) return null;
  return Option.getOrNull(
    decodeLocation({
      ...option,
      latitude: finiteOrNull(option.latitude),
      longitude: finiteOrNull(option.longitude),
    }),
  );
}
