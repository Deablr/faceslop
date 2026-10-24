// Pure functions that turn Facebook HTML / GraphQL payloads into domain types. No Effect runtime,
// no Playwright: everything is unit-tested against test/fixtures. Port of legacy/src/server/fb/extract.ts.
//
// Facebook's nesting changes often; key names change rarely. So we walk parsed JSON for known keys
// instead of following hardcoded paths, and treat every field as optional: odd shapes become nulls
// or skipped records, never exceptions. Every emitted listing / detail / location goes through
// conform.ts, so it satisfies the domain schemas.
import '@tanstack/react-start/server-only';
import { Predicate } from 'effect';
import { conformDetail, conformLocation, conformSummary } from '@/server/marketplace/conform';
import { listingUrl } from '@/server/marketplace/urls';
import type {
  ListingAttribute,
  ListingDetail,
  ListingStatus,
  ListingSummary,
  LocationOption,
  Price,
  SearchLocationInfo,
  SellerInfo,
} from '@/shared/domain';

type Obj = Readonly<Record<PropertyKey, unknown>>;

export interface PageInfo {
  readonly endCursor: string | null;
  readonly hasNextPage: boolean;
}

/** A Relay query the page preloaded (from `expectedPreloaders`); replayable with a new cursor. */
export interface PreloadedQuery {
  readonly queryName: string;
  readonly queryID: string;
  readonly variables: Obj;
}

/** Request tokens embedded in a facebook.com page, needed to call /api/graphql/ from it. */
export interface PageTokens {
  readonly lsd: string | null;
  /** Only present when logged in. */
  readonly fbDtsg: string | null;
  /** "0" when logged out. */
  readonly userId: string;
}

// ---------- generic helpers ----------

const isObj = (v: unknown): v is Obj => Predicate.isObject(v);
const str = (v: unknown): string | null => (Predicate.isString(v) && v.length > 0 ? v : null);
const idStr = (v: unknown): string | null =>
  Predicate.isString(v) && v.length > 0 ? v : Predicate.isNumber(v) && Number.isFinite(v) ? String(v) : null;
const get = (o: unknown, ...path: readonly string[]): unknown => {
  let cur = o;
  for (const k of path) {
    if (!isObj(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
};
const num = (v: unknown): number | null => {
  if (Predicate.isNumber(v)) return Number.isFinite(v) ? v : null;
  if (Predicate.isString(v) && v.trim() !== '') {
    const n = Number(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

/**
 * Depth-first walk over parsed JSON, in document order. `visit` returns false to skip an
 * object's children. Iterative so deeply nested Relay payloads can't overflow the stack.
 */
function walk(root: unknown, visit: (o: Obj) => boolean | undefined): void {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const cur = stack.pop();
    if (Array.isArray(cur)) {
      for (let i = cur.length - 1; i >= 0; i--) stack.push(cur[i]);
    } else if (isObj(cur)) {
      if (visit(cur) === false) continue;
      const values = Object.values(cur);
      for (let i = values.length - 1; i >= 0; i--) {
        const value = values[i];
        if (Predicate.isObjectOrArray(value)) stack.push(value);
      }
    }
  }
}

/** Every object (in document order) that has `key`. Doesn't descend into matches. */
function findAll(root: unknown, key: string): Obj[] {
  const out: Obj[] = [];
  walk(root, (o) => {
    if (key in o) {
      out.push(o);
      return false;
    }
    return undefined;
  });
  return out;
}

// ---------- raw payloads ----------

/** Parse every `<script type="application/json">` tag in a page; tags that aren't valid JSON are skipped. */
export function extractJsonBlobs(html: string): unknown[] {
  const out: unknown[] = [];
  for (const match of html.matchAll(/<script\b[^>]*\btype="application\/json"[^>]*>([\s\S]*?)<\/script>/g)) {
    const parsed = parseJson(match[1] ?? '');
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

/** JSON.parse, or undefined for anything that isn't valid JSON (truncated payloads, junk lines). */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * A /api/graphql/ response body: one or more JSON documents separated by newlines
 * (Relay @stream/@defer), sometimes behind a `for (;;);` guard.
 */
export function parseGraphqlBody(text: string): unknown[] {
  const out: unknown[] = [];
  for (const raw of text.replace(/^for \(;;\);/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const parsed = parseJson(line);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

/** GraphQL error messages in parsed response documents (empty when none). */
export function graphqlErrors(docs: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const d of docs) {
    const errs = get(d, 'errors');
    if (Array.isArray(errs)) for (const e of errs) out.push(str(get(e, 'message')) ?? 'unknown error');
    const single = str(get(d, 'error')) ?? str(get(d, 'errorSummary'));
    if (single) out.push(single);
  }
  return out;
}

// ---------- listings ----------

function formatMoney(amount: number, currency: string | null): string {
  if (amount === 0) return 'Free';
  const whole = Number.isInteger(amount);
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency ?? 'USD',
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: whole ? 0 : 2,
    }).format(amount);
  } catch {
    // Unknown currency code.
    return `${currency ?? '$'}${amount}`;
  }
}

/** Facebook's "amount_with_offset" values are in minor units (cents). */
const fromOffset = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : n / 100;
};

function priceFrom(o: Obj): Price {
  const lp = get(o, 'listing_price');
  const currency = str(get(lp, 'currency')) ?? str(get(o, 'data', 'price', 'currency'));
  const amount =
    num(get(lp, 'amount')) ??
    fromOffset(get(lp, 'amount_with_offset_in_currency')) ??
    // the nearby feed's paginated cards: cents under data.price
    fromOffset(get(o, 'data', 'price', 'amount_with_offset'));
  const formatted =
    str(get(lp, 'formatted_amount_zeros_stripped')) ?? str(get(lp, 'formatted_amount')) ?? str(get(o, 'formatted_price', 'text'));
  if (amount === 0) return { amount: 0, formatted: 'Free', currency };
  if (formatted && /^free$/i.test(formatted)) return { amount: amount ?? 0, formatted: 'Free', currency };
  return { amount, formatted: formatted ?? (amount !== null ? formatMoney(amount, currency) : ''), currency };
}

function previousPriceFrom(o: Obj, currency: string | null): string | null {
  const sp = get(o, 'strikethrough_price');
  if (!isObj(sp)) return null;
  const formatted = str(sp.formatted_amount) ?? str(sp.formatted_amount_zeros_stripped);
  if (formatted) return formatted;
  const amount = num(sp.amount) ?? fromOffset(sp.amount_with_offset) ?? fromOffset(sp.amount_with_offset_in_currency);
  return amount !== null && amount > 0 ? formatMoney(amount, currency) : null;
}

function statusFrom(o: Obj): ListingStatus {
  if (o.is_sold === true) return 'sold';
  if (o.is_pending === true) return 'pending';
  const rendered = str(o.renderable_listing_status)?.toUpperCase();
  if (rendered === 'SOLD') return 'sold';
  if (rendered === 'PENDING') return 'pending';
  if (o.is_live === true || rendered === 'AVAILABLE') return 'available';
  return 'unknown';
}

function locationFrom(o: Obj): string | null {
  const geo = get(o, 'location', 'reverse_geocode') ?? get(o, 'entity', 'location', 'reverse_geocode');
  const city = str(get(geo, 'city'));
  const state = str(get(geo, 'state'));
  if (city && state) return `${city}, ${state}`;
  return city ?? str(get(o, 'location_text', 'text')) ?? str(get(geo, 'city_page', 'display_name')) ?? null;
}

const sellerOf = (o: Obj): Obj | null => {
  const s = o.marketplace_listing_seller;
  return isObj(s) ? s : null;
};

const epochMillis = (seconds: number | null): number | null => (seconds !== null && seconds > 0 ? seconds * 1000 : null);

/**
 * Normalize one Facebook listing object (GroupCommerceProductItem) into a ListingSummary.
 * Null when it has no usable (numeric) id.
 */
export function normalizeListing(o: Obj): ListingSummary | null {
  const id = idStr(o.id);
  if (!id) return null;
  const price = priceFrom(o);
  const seller = sellerOf(o);
  const photos = o.listing_photos;
  return conformSummary({
    id,
    title: str(o.marketplace_listing_title) ?? str(o.base_marketplace_listing_title) ?? str(o.custom_title) ?? '',
    price,
    previousPrice: previousPriceFrom(o, price.currency),
    imageUrl:
      str(get(o, 'primary_listing_photo', 'image', 'uri')) ??
      str(get(o, 'primary_listing_photo', 'listing_image', 'uri')) ??
      (Array.isArray(photos) ? str(get(photos[0], 'image', 'uri')) : null),
    location: locationFrom(o),
    createdAt: epochMillis(num(o.creation_time)),
    status: statusFrom(o),
    sellerId: seller ? idStr(seller.id) : null,
    sellerName: seller ? str(seller.name) : null,
    deliveryTypes: Array.isArray(o.delivery_types) ? o.delivery_types.filter(Predicate.isString) : [],
    categoryId: idStr(o.marketplace_listing_category_id),
    url: listingUrl(id),
  });
}

/**
 * The nearby feed's paginated units ("MarketplaceFeedGeneralListingObject") carry a slimmer
 * listing: title/price under `data` (price in cents), the photo under `photo.default_image`,
 * location under `entity`.
 */
function normalizeFeedListing(o: Obj): ListingSummary | null {
  const id = idStr(o.entity_id) ?? idStr(get(o, 'listing', 'id'));
  const title = str(get(o, 'data', 'title'));
  // This shape is matched loosely, so insist on a real (numeric) listing id.
  if (!id || !/^\d+$/.test(id) || title === null) return null;
  const price = priceFrom(o);
  return conformSummary({
    id,
    title,
    price,
    previousPrice: previousPriceFrom(o, price.currency),
    imageUrl: str(get(o, 'photo', 'default_image', 'uri')) ?? str(get(o, 'photo', 'image', 'uri')),
    location: locationFrom(o),
    createdAt: epochMillis(num(get(o, 'listing', 'creation_time'))),
    status: 'available',
    sellerId: null,
    sellerName: null,
    deliveryTypes: [],
    categoryId: null,
    url: listingUrl(id),
  });
}

/** A value the first copy of a listing is missing, so a later copy may fill it. */
const isGap = (key: keyof ListingSummary, value: unknown): boolean =>
  value === null || value === '' || (Array.isArray(value) && value.length === 0) || (key === 'status' && value === 'unknown');

/** `first`, with its gaps filled from `later` (another copy of the same listing). */
function fillGaps(first: ListingSummary, later: ListingSummary): ListingSummary {
  const pick = <K extends keyof ListingSummary>(key: K): ListingSummary[K] => (isGap(key, first[key]) ? later[key] : first[key]);
  return {
    id: first.id,
    title: pick('title'),
    price: pick('price'),
    previousPrice: pick('previousPrice'),
    imageUrl: pick('imageUrl'),
    location: pick('location'),
    createdAt: pick('createdAt'),
    status: pick('status'),
    sellerId: pick('sellerId'),
    sellerName: pick('sellerName'),
    deliveryTypes: pick('deliveryTypes'),
    categoryId: pick('categoryId'),
    url: pick('url'),
  };
}

/**
 * Every listing anywhere under `root` (page blobs or GraphQL documents), normalized and
 * de-duplicated by id. When the same listing appears twice, missing fields of the first
 * occurrence are filled from later ones.
 */
export function findListings(root: unknown): ListingSummary[] {
  const byId = new Map<string, ListingSummary>();
  const add = (listing: ListingSummary | null) => {
    if (!listing) return;
    const first = byId.get(listing.id);
    byId.set(listing.id, first ? fillGaps(first, listing) : listing);
  };
  walk(root, (o) => {
    if (Predicate.isString(o.marketplace_listing_title)) {
      add(normalizeListing(o));
      return false;
    }
    if (o.__typename === 'MarketplaceFeedGeneralListingObject' || ('entity_id' in o && isObj(o.data) && 'title' in o.data)) {
      add(normalizeFeedListing(o));
      return false;
    }
    return undefined;
  });
  return [...byId.values()];
}

// ---------- search page metadata ----------

/**
 * The results feed's pagination state. Prefers the search feed's page_info
 * (`marketplace_search.feed_units`), else the last page_info found (the nearby feed puts it beside the feed).
 */
export function extractPageInfo(root: unknown): PageInfo | null {
  const feedInfos: Obj[] = [];
  const infos: Obj[] = [];
  walk(root, (o) => {
    const feedInfo = get(o, 'feed_units', 'page_info');
    if (isObj(feedInfo)) feedInfos.push(feedInfo);
    const pi = o.page_info;
    if (isObj(pi) && ('end_cursor' in pi || 'has_next_page' in pi)) infos.push(pi);
    return undefined;
  });
  const pi = feedInfos[0] ?? infos[infos.length - 1];
  if (!pi) return null;
  const endCursor = str(pi.end_cursor);
  return { endCursor, hasNextPage: pi.has_next_page === true && endCursor !== null };
}

/** Where the results are centered: name, coordinates, radius. */
export function extractSearchLocation(root: unknown): SearchLocationInfo | null {
  const brp = findAll(root, 'filter_location_latitude')[0];
  const routeLoc = findAll(root, 'initialRouteInfo')
    .map((o) => get(o, 'initialRouteInfo', 'route', 'rootView', 'props', 'location'))
    .find(isObj);
  const names: string[] = [];
  const cities: string[] = [];
  walk(root, (o) => {
    const bl = o.buy_location;
    const display = str(get(bl, 'display_name'));
    if (display) names.push(display);
    // logged-out search pages sometimes only carry the city
    const city = str(get(bl, 'buy_location', 'location', 'reverse_geocode', 'city'));
    if (city) cities.push(city);
    return undefined;
  });
  const name = names[0] ?? cities[0] ?? null;
  const latitude = num(brp?.filter_location_latitude) ?? num(get(routeLoc, 'latitude'));
  const longitude = num(brp?.filter_location_longitude) ?? num(get(routeLoc, 'longitude'));
  const radiusKm = num(brp?.filter_radius_km) ?? num(get(routeLoc, 'radius'));
  if (name === null && latitude === null && longitude === null) return null;
  return { name, latitude, longitude, radiusKm };
}

/** Marketplace route the page rendered, e.g. "/marketplace/{location_id}/search/". Null if unknown. */
export function extractRoutePath(root: unknown): string | null {
  for (const o of findAll(root, 'initialRouteInfo')) {
    const p = str(get(o, 'initialRouteInfo', 'route', 'routePath'));
    if (p) return p;
  }
  return null;
}

/** Which kind of Marketplace feed the payload contains, if any ('home' = the nearby feed). */
export function detectFeedKind(root: unknown): 'search' | 'home' | null {
  const kinds = new Set<'search' | 'home'>();
  walk(root, (o) => {
    if ('marketplace_search' in o || 'filter_location_latitude' in o) kinds.add('search');
    if ('marketplace_home_feed' in o) kinds.add('home');
    return undefined;
  });
  return kinds.has('search') ? 'search' : kinds.has('home') ? 'home' : null;
}

/** The page's preloaded Relay queries (name, doc id, variables). */
export function extractPreloadedQueries(root: unknown): PreloadedQuery[] {
  const out: PreloadedQuery[] = [];
  for (const o of findAll(root, 'expectedPreloaders')) {
    const list = o.expectedPreloaders;
    if (!Array.isArray(list)) continue;
    for (const p of list) {
      const queryName = str(get(p, 'queryName'));
      const queryID = idStr(get(p, 'queryID'));
      const variables = get(p, 'variables');
      if (queryName && queryID && isObj(variables)) out.push({ queryName, queryID, variables });
    }
  }
  return out;
}

/** The preloaded query that fetches the results feed (has a `cursor` variable), if any. */
export function findFeedQuery(queries: readonly PreloadedQuery[]): PreloadedQuery | null {
  const withCursor = queries.filter((q) => 'cursor' in q.variables);
  return (
    withCursor.find((q) => q.queryName.endsWith('SearchContentContainerQuery')) ??
    withCursor.find((q) => /BrowseFeed.*ContainerQuery$/.test(q.queryName)) ??
    withCursor[0] ??
    null
  );
}

/** CSRF-ish tokens Facebook expects on /api/graphql/ requests made from a page. */
export function extractPageTokens(html: string): PageTokens {
  const lsd = /\["LSD",\[\],\{"token":"([^"]+)"/.exec(html)?.[1] ?? /"lsd":\{"name":"lsd","value":"([^"]+)"/.exec(html)?.[1] ?? null;
  const fbDtsg = /\["DTSGInitialData",\[\],\{"token":"([^"]+)"/.exec(html)?.[1] ?? null;
  const userId = /\["CurrentUserInitialData",\[\],\{[^}]*?"USER_ID":"(\d+)"/.exec(html)?.[1] ?? /"actorID":"(\d+)"/.exec(html)?.[1] ?? '0';
  return { lsd, fbDtsg, userId };
}

/** Facebook's jazoest checksum: "2" followed by the sum of the token's char codes. */
export function jazoest(token: string): string {
  let sum = 0;
  for (let i = 0; i < token.length; i++) sum += token.charCodeAt(i);
  return `2${sum}`;
}

/** Title of Facebook's "This content isn't available" error route, if the page rendered one. */
export function extractErrorRoute(root: unknown): string | null {
  for (const o of findAll(root, 'initialRouteInfo')) {
    const route = get(o, 'initialRouteInfo', 'route');
    const canonical = str(get(route, 'canonicalRouteName')) ?? '';
    const policy = str(get(route, 'tracePolicy')) ?? '';
    if (canonical.includes('ErrorRoute') || policy === 'comet.error') {
      return str(get(route, 'rootView', 'props', 'title')) ?? 'Content not available';
    }
  }
  return null;
}

// ---------- listing detail ----------

/** Merge Relay fragments of the same record: earlier non-empty values win, nested objects merge. */
function mergeFragments(parts: readonly Obj[]): Obj {
  const out: Record<string, unknown> = {};
  for (const p of parts) {
    for (const [k, v] of Object.entries(p)) {
      const cur = out[k];
      if (cur === undefined || cur === null) out[k] = v;
      else if (isObj(cur) && isObj(v)) out[k] = mergeFragments([cur, v]);
    }
  }
  return out;
}

function sellerFrom(o: Obj): SellerInfo | null {
  const s = sellerOf(o);
  const id = s ? idStr(s.id) : null;
  if (!s || !id) return null;
  const stats = s.marketplace_ratings_stats_by_role_v2;
  const isPrivate = get(stats, 'seller_ratings_are_private') === true;
  const count = num(get(stats, 'seller_stats', 'five_star_total_rating_count_by_role'));
  const avg = num(get(stats, 'seller_stats', 'five_star_ratings_average'));
  const joined = num(s.join_time);
  return {
    id,
    name: str(s.name) ?? 'Facebook user',
    avatarUrl:
      str(get(s, 'profile_picture', 'uri')) ??
      str(get(s, 'profile_picture_160', 'uri')) ??
      str(get(s, 'commerce_profile_picture_with_fallback_160', 'uri')),
    rating: isPrivate || !count ? null : avg,
    ratingCount: isPrivate ? null : count,
    joinedText: joined && joined > 0 ? `Joined Facebook in ${new Date(joined * 1000).getUTCFullYear()}` : null,
  };
}

function attributesFrom(o: Obj): ListingAttribute[] {
  if (!Array.isArray(o.attribute_data)) return [];
  const out: ListingAttribute[] = [];
  for (const a of o.attribute_data) {
    const label = str(get(a, 'attribute_name'));
    const value = str(get(a, 'label')) ?? str(get(a, 'value'));
    if (label && value) out.push({ label, value });
  }
  return out;
}

/** All fragments of listing `id`, merged; null when the payload has no such listing. */
function collectListingRecord(blobs: unknown, id: string): Obj | null {
  const fragments: Obj[] = [];
  const targets: Obj[] = [];
  walk(blobs, (o) => {
    const target = get(o, 'marketplace_product_details_page', 'target');
    if (isObj(target) && idStr(target.id) === id) targets.push(target);
    if (idStr(o.id) === id && (o.__typename === 'GroupCommerceProductItem' || 'marketplace_listing_title' in o)) {
      fragments.push(o);
    }
    return undefined;
  });
  // The product-details targets are the authoritative fragments; other copies only fill gaps.
  const merged = mergeFragments([...targets, ...fragments.filter((f) => !targets.includes(f))]);
  return 'marketplace_listing_title' in merged || 'redacted_description' in merged ? merged : null;
}

/** Id of the listing an item page actually rendered (Facebook may show a canonical listing for another id). */
function productDetailsTargetId(blobs: unknown): string | null {
  for (const o of findAll(blobs, 'marketplace_product_details_page')) {
    const id = idStr(get(o, 'marketplace_product_details_page', 'target', 'id'));
    if (id) return id;
  }
  return null;
}

/**
 * The listing detail for `id` from an item page's blobs, or null when the page has no such listing.
 * Relay splits the record across several blobs (photos in one, description/seller in another);
 * all fragments of the record are merged first.
 */
export function extractListingDetail(blobs: unknown, id: string): ListingDetail | null {
  let merged = collectListingRecord(blobs, id);
  if (!merged) {
    const rendered = productDetailsTargetId(blobs);
    if (rendered && rendered !== id) merged = collectListingRecord(blobs, rendered);
  }
  if (!merged) return null;

  const summary = normalizeListing(merged);
  if (!summary) return null;

  const photos: string[] = [];
  if (Array.isArray(merged.listing_photos)) {
    for (const p of merged.listing_photos) {
      const uri = str(get(p, 'image', 'uri'));
      if (uri && !photos.includes(uri)) photos.push(uri);
    }
  }
  if (photos.length === 0 && summary.imageUrl) photos.push(summary.imageUrl);

  const attributes = attributesFrom(merged);
  const condition = attributes.find((a) => /condition/i.test(a.label))?.value ?? null;

  const categoryNames: string[] = [];
  walk(merged, (o) => {
    const name = str(o.marketplace_listing_category_name);
    if (name) categoryNames.push(name);
    return undefined;
  });

  return conformDetail({
    ...summary,
    location: str(get(merged, 'location_text', 'text')) ?? summary.location,
    imageUrl: summary.imageUrl ?? photos[0] ?? null,
    description: str(get(merged, 'redacted_description', 'text')) ?? '',
    photos,
    condition,
    attributes,
    categoryName: categoryNames[0] ?? null,
    seller: sellerFrom(merged),
    shippingOffered: merged.is_shipping_offered === true || merged.shipping_offered === true,
    canMessage: merged.can_viewer_message_listing === true,
    hasMessaged: merged.has_viewer_messaged === true,
    isViewerSeller: merged.is_viewer_seller === true,
  });
}

/** True when the item page rendered a product-details page at all (even for a different/removed id). */
export function hasProductDetailsPage(root: unknown): boolean {
  return findAll(root, 'marketplace_product_details_page').length > 0;
}

// ---------- location typeahead ----------

/** Strip Facebook's check-in counts from typeahead subtitles ("Denver, CO · 582,235 people checked in here"). */
function cleanSubtitle(s: string | null): string | null {
  if (!s) return null;
  const kept = s
    .split('·')
    .map((p) => p.trim())
    .filter((p) => p && !/checked in here/i.test(p));
  return kept.length ? kept.join(' · ') : null;
}

/** LocationOptions from MarketplaceSearchAddressDataSourceQuery responses (city_street_search results). */
export function extractLocationOptions(root: unknown): LocationOption[] {
  const out = new Map<string, LocationOption>();
  walk(root, (o) => {
    if (!('single_line_address' in o)) return undefined;
    const id = idStr(get(o, 'page', 'id'));
    const name = str(o.single_line_address);
    if (id && name && !out.has(id)) {
      const option = conformLocation({
        id,
        name,
        subtitle: cleanSubtitle(str(o.subtitle)),
        latitude: num(get(o, 'location', 'latitude')),
        longitude: num(get(o, 'location', 'longitude')),
      });
      if (option) out.set(id, option);
    }
    return false;
  });
  return [...out.values()];
}

/** True when a typeahead response carries the results field at all (even an empty or null one). */
export function hasLocationResults(docs: readonly unknown[]): boolean {
  return docs.some((d) => get(d, 'data', 'city_street_search') !== undefined);
}
