// Builds facebook.com Marketplace URLs. Pure (no Effect, no Playwright). Port of legacy/src/server/fb/urls.ts.
//
// Verified against facebook.com (logged out):
//   /marketplace/{loc}/search/?query=…        search ({loc} = vanity slug like "nyc" or a numeric city page id)
//   /marketplace/{loc}/{category}/[?query=…]  category browse, optionally searching within it
//   /marketplace/{loc}/                       nearby "Today's picks" feed (Facebook ignores filters here)
//   /marketplace/search/?query=…, /marketplace/category/{category}/, /marketplace/
//                                             same without a location (account or IP-based location)
// Filters: radius (km), minPrice/maxPrice (whole dollars), sortBy, daysSinceListed,
// itemCondition (comma-separated), deliveryMethod, exact=true.
import '@tanstack/react-start/server-only';
import type { SearchParams } from '@/shared/domain';

/**
 * Same value as Browser's FB_ORIGIN. Repeated here so this module stays pure: importing
 * Browser.ts would load Playwright into every unit test of the URL builders.
 */
export const FB_ORIGIN = 'https://www.facebook.com';

/** Facebook's nearby feed for the account/IP location; also the warm page for location lookups. */
export const MARKETPLACE_HOME = `${FB_ORIGIN}/marketplace/`;

const segment = (s: string) => encodeURIComponent(s.trim());
const isFiniteNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** True when the params produce Facebook's nearby home feed (no query, no category), where filters don't apply. */
export function isNearbyBrowse(params: SearchParams): boolean {
  return !params.query?.trim() && !params.category?.trim();
}

/** The Marketplace page URL that shows results for `params` (search, category browse, or nearby browse). */
export function marketplaceUrl(params: SearchParams): string {
  const query = params.query?.trim() ?? '';
  const category = params.category?.trim() ?? '';
  const location = params.location?.trim() ?? '';
  const base = location ? `${FB_ORIGIN}/marketplace/${segment(location)}/` : MARKETPLACE_HOME;

  if (!query && !category) return base;

  const path = category ? (location ? `${base}${segment(category)}/` : `${base}category/${segment(category)}/`) : `${base}search/`;

  const qs = new URLSearchParams();
  if (query) qs.set('query', query);
  if (isFiniteNumber(params.minPrice) && params.minPrice > 0) qs.set('minPrice', String(Math.floor(params.minPrice)));
  if (isFiniteNumber(params.maxPrice) && params.maxPrice > 0) qs.set('maxPrice', String(Math.ceil(params.maxPrice)));
  if (params.sortBy && params.sortBy !== 'best_match') qs.set('sortBy', params.sortBy);
  if (params.daysSinceListed) qs.set('daysSinceListed', String(params.daysSinceListed));
  if (params.conditions?.length) qs.set('itemCondition', [...new Set(params.conditions)].join(','));
  if (params.delivery && params.delivery !== 'all') qs.set('deliveryMethod', params.delivery);
  if (isFiniteNumber(params.radiusKm) && params.radiusKm > 0) qs.set('radius', String(Math.round(params.radiusKm)));
  if (params.exact && query) qs.set('exact', 'true');

  const search = qs.toString();
  return search ? `${path}?${search}` : path;
}

/** Canonical facebook.com URL of a listing. */
export function listingUrl(id: string): string {
  return `${FB_ORIGIN}/marketplace/item/${encodeURIComponent(id)}/`;
}
