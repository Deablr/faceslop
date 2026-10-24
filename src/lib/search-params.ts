// Search params: URL validation for /search (TanStack Router `validateSearch`), the canonical form
// sent to the server and used in query keys, URL encoding, and display helpers.
//
// The URL is lenient: a hand-edited or outdated value is dropped (or clamped), never an error page.
// Each field is checked with the domain's own Schema, so the URL can't hold anything the server's
// `search` validator would reject.
import { Option, Schema } from 'effect';
import type { Format } from '@/lib/format';
import {
  CategorySlug,
  Condition,
  DaysSinceListed,
  DeliveryMethod,
  LocationId,
  RadiusKm,
  SortBy,
  WholeDollars,
  type SearchParams,
  type Settings,
} from '@/shared/domain';

/** /search URL state: SearchParams plus the display name of the chosen location (UI only). */
export interface SearchPageSearch extends SearchParams {
  readonly locationName?: string;
}

export interface Choice<T> {
  readonly value: T;
  readonly label: string;
}

export const SORT_OPTIONS: readonly Choice<SortBy>[] = [
  { value: 'best_match', label: 'Best match' },
  { value: 'creation_time_descend', label: 'Newest first' },
  { value: 'price_ascend', label: 'Price: low to high' },
  { value: 'price_descend', label: 'Price: high to low' },
  { value: 'distance_ascend', label: 'Nearest first' },
];

export const CONDITION_OPTIONS: readonly Choice<Condition>[] = [
  { value: 'new', label: 'New' },
  { value: 'used_like_new', label: 'Used – like new' },
  { value: 'used_good', label: 'Used – good' },
  { value: 'used_fair', label: 'Used – fair' },
];

export const DAYS_OPTIONS: readonly Choice<DaysSinceListed>[] = [
  { value: 1, label: 'Last 24 hours' },
  { value: 7, label: 'Last 7 days' },
  { value: 30, label: 'Last 30 days' },
];

export const DELIVERY_OPTIONS: readonly Choice<DeliveryMethod>[] = [
  { value: 'all', label: 'All' },
  { value: 'local_pick_up', label: 'Local pickup' },
  { value: 'shipping', label: 'Shipping' },
];

const MAX_QUERY_LENGTH = 200;
const MAX_LOCATION_NAME_LENGTH = 200;

// ---------- lenient field decoding ----------

const decodeFinite = Schema.decodeUnknownOption(Schema.FiniteFromString);
const isCategory = Schema.is(CategorySlug);
const isLocation = Schema.is(LocationId);
const isRadius = Schema.is(RadiusKm);
const isDollars = Schema.is(WholeDollars);
const isSort = Schema.is(SortBy);
const isCondition = Schema.is(Condition);
const isDays = Schema.is(DaysSinceListed);
const isDelivery = Schema.is(DeliveryMethod);

/** URL values arrive as strings, numbers or booleans (the router turns "12" into 12). */
function text(value: unknown): string | undefined {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function wholeNumber(value: unknown): number | undefined {
  const raw = text(value);
  if (raw === undefined) return undefined;
  return Option.match(decodeFinite(raw), { onNone: () => undefined, onSome: (n) => Math.round(n) });
}

function list(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap((item) => list(item));
  const raw = text(value);
  return raw === undefined ? [] : raw.split(',').map((part) => part.trim());
}

function flag(value: unknown): true | undefined {
  return value === true || value === 1 || value === 'true' || value === '1' ? true : undefined;
}

const pick = <T>(value: unknown, valid: (v: unknown) => v is T): T | undefined =>
  value !== undefined && valid(value) ? value : undefined;

/** Drop undefined keys so equal searches serialize, compare and cache identically. */
function compact<T extends object>(obj: T): T {
  // Object.fromEntries loses the key types; the keys and values are unchanged apart from removal.
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

/**
 * Canonical SearchParams from anything URL-ish: invalid values are dropped, defaults are omitted
 * (best match, all delivery, not exact), conditions are de-duplicated in a fixed order, and a
 * min price above the max price is swapped.
 */
export function normalizeSearchParams(raw: Readonly<Record<string, unknown>>): SearchParams {
  const query = text(raw.query)?.slice(0, MAX_QUERY_LENGTH).trim();
  const sortBy = pick(text(raw.sortBy), isSort);
  const delivery = pick(text(raw.delivery), isDelivery);
  const conditionValues = list(raw.conditions);
  const conditions = CONDITION_OPTIONS.map((o) => o.value).filter((c) => conditionValues.includes(c) && isCondition(c));
  let minPrice = pick(wholeNumber(raw.minPrice), isDollars);
  let maxPrice = pick(wholeNumber(raw.maxPrice), isDollars);
  if (minPrice !== undefined && maxPrice !== undefined && minPrice > maxPrice) [minPrice, maxPrice] = [maxPrice, minPrice];
  return compact<SearchParams>({
    query: query === '' ? undefined : query,
    category: pick(text(raw.category), isCategory),
    location: pick(text(raw.location), isLocation),
    radiusKm: pick(wholeNumber(raw.radiusKm), isRadius),
    minPrice,
    maxPrice,
    sortBy: sortBy === 'best_match' ? undefined : sortBy,
    daysSinceListed: pick(wholeNumber(raw.daysSinceListed), isDays),
    conditions: conditions.length > 0 ? conditions : undefined,
    delivery: delivery === 'all' ? undefined : delivery,
    exact: flag(raw.exact),
  });
}

/** `validateSearch` for /search. */
export function validateSearchPageSearch(raw: Readonly<Record<string, unknown>>): SearchPageSearch {
  const params = normalizeSearchParams(raw);
  const locationName = params.location === undefined ? undefined : text(raw.locationName)?.slice(0, MAX_LOCATION_NAME_LENGTH);
  return locationName === undefined ? params : { ...params, locationName };
}

/** What the server's `search` function gets: the URL state without UI-only keys, canonical. */
export function toApiParams(search: SearchPageSearch): SearchParams {
  const { locationName: _locationName, ...params } = search;
  return normalizeSearchParams(params);
}

/** Stable identity for comparing searches (e.g. "is this search already saved?"). */
export function searchIdentity(params: SearchParams): string {
  const normalized: Readonly<Record<string, unknown>> = normalizeSearchParams(params);
  return JSON.stringify(
    Object.keys(normalized)
      .sort()
      .map((key) => [key, normalized[key]]),
  );
}

/**
 * Nearby browse: no query and no category. Facebook answers it with its "Today's picks" feed,
 * which ignores every filter, so the UI disables them in this mode.
 */
export function isNearbyBrowse(params: SearchParams): boolean {
  return params.query === undefined && params.category === undefined;
}

/**
 * A NEW search (search box away from /search, a category chip, "Browse nearby") starts from the
 * default location and radius in Settings. The server never fills these in.
 */
export function withSearchDefaults(search: SearchPageSearch, settings: Settings | undefined): SearchPageSearch {
  if (settings === undefined) return search;
  const location =
    search.location === undefined && settings.defaultLocation !== null
      ? { location: settings.defaultLocation.id, locationName: settings.defaultLocation.name }
      : {};
  const radius =
    search.radiusKm === undefined && settings.defaultRadiusKm !== null ? { radiusKm: settings.defaultRadiusKm } : {};
  return { ...search, ...location, ...radius };
}

/** Number of filters set beyond query, category and location. */
export function countActiveFilters(params: SearchParams): number {
  return [
    params.radiusKm,
    params.minPrice ?? params.maxPrice,
    params.sortBy,
    params.daysSinceListed,
    params.conditions,
    params.delivery,
    params.exact,
  ].filter((v) => v !== undefined).length;
}

export function humanizeSlug(slug: string): string {
  const words = slug.replace(/[-_]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const labelOf = <T>(options: readonly Choice<T>[], value: T): string | undefined =>
  options.find((o) => o.value === value)?.label;

/** Short human summary, e.g. "Bicycles · $50–$300 · Used – good · within 40 mi". */
export function describeSearch(params: SearchParams, format: Format, categoryName?: string | null): string {
  const parts: (string | undefined)[] = [];
  if (params.category !== undefined) parts.push(categoryName ?? humanizeSlug(params.category));
  if (params.minPrice !== undefined && params.maxPrice !== undefined) {
    parts.push(`${format.money(params.minPrice)}–${format.money(params.maxPrice)}`);
  } else if (params.maxPrice !== undefined) {
    parts.push(`under ${format.money(params.maxPrice)}`);
  } else if (params.minPrice !== undefined) {
    parts.push(`over ${format.money(params.minPrice)}`);
  }
  for (const c of params.conditions ?? []) parts.push(labelOf(CONDITION_OPTIONS, c));
  if (params.daysSinceListed !== undefined) parts.push(labelOf(DAYS_OPTIONS, params.daysSinceListed));
  if (params.delivery !== undefined) parts.push(labelOf(DELIVERY_OPTIONS, params.delivery));
  if (params.radiusKm !== undefined) parts.push(`within ${format.distanceKm(params.radiusKm)}`);
  if (params.sortBy !== undefined) parts.push(labelOf(SORT_OPTIONS, params.sortBy));
  if (params.exact === true) parts.push('exact matches');
  return parts.filter((p): p is string => p !== undefined && p !== '').join(' · ');
}

/** A sensible default name when saving a search. */
export function defaultSearchName(params: SearchParams, categoryName?: string | null): string {
  if (params.query !== undefined) return params.query;
  if (params.category !== undefined) return categoryName ?? humanizeSlug(params.category);
  return 'Nearby';
}

// ---------- URL encoding (router parseSearch / stringifySearch) ----------

/**
 * Readable URLs: `?query=road+bike&conditions=new,used_good&radiusKm=40`. Arrays become
 * comma-separated lists; everything else is its plain string. `validateSearch` coerces back.
 */
export function stringifySearchValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(',');
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
