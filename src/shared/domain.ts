// The domain contract shared by server and client: Effect Schemas for every type the UI and the
// server exchange, ported from legacy/src/shared/types.ts (same field names and semantics) with
// the validation rules of legacy/src/server/routes/schemas.ts.
//
// Conventions:
// - `export const X = Schema...` + `export type X = typeof X.Type`. For input schemas whose decoded
//   form differs from what the client sends, `XEncoded` is exported too (server functions take
//   the Encoded form as their input type automatically).
// - Output-only types (ListingDetail, SearchResult, ...) are never decoded at runtime on the hot
//   path; their schemas document the contract and are used in tests and for stored JSON.
// - Client-safe: no server imports here.
import { Effect, Schema, SchemaTransformation } from 'effect';

// ---------- primitives ----------

const Text = (max: number) => Schema.String.check(Schema.isMaxLength(max));
const TrimmedText = (max: number) => Schema.Trim.check(Schema.isMaxLength(max));
const RequiredText = (max: number) =>
  Schema.Trim.check(Schema.isMinLength(1, { message: 'is required' }), Schema.isMaxLength(max));
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Unix epoch milliseconds. */
export const EpochMillis = Schema.Finite;

/** A Marketplace listing id (numeric). The engine additionally rejects ids over 20 digits (Facebook loops). */
export const ListingId = Schema.String.check(Schema.isPattern(/^\d{1,25}$/, { message: 'must be a numeric listing id' }));
export type ListingId = typeof ListingId.Type;

/** A Facebook id for sellers/users: numeric in practice, but accept any short token-ish string. */
export const FbId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/, { message: 'must be a valid id' }));
export type FbId = typeof FbId.Type;

/** Facebook location: a vanity slug ("nyc", "austin") or a numeric city page id ("115590505119035"). */
export const LocationId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9._-]{1,80}$/, { message: 'must be a location id or slug' }),
);
export type LocationId = typeof LocationId.Type;

/** Marketplace category slug, e.g. "bicycles". */
export const CategorySlug = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/, { message: 'must be a category slug' }),
);

/** Opaque "load more" handle returned by search. */
export const SearchSessionId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/, { message: 'must be a search session id' }),
);

/** Saved search primary key (positive integer). */
export const SavedSearchId = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999_999_999_999 }));
export type SavedSearchId = typeof SavedSearchId.Type;

/** Absolute http(s) URL (listing/image URLs from Facebook). */
export const HttpUrl = Schema.String.check(
  Schema.isMaxLength(4000),
  Schema.isPattern(/^https?:\/\//i, { message: 'must be an http(s) URL' }),
);

/** Search radius in km. */
export const RadiusKm = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 500 }));

/** Whole dollars, for price filters. */
export const WholeDollars = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_000_000_000 }));

// ---------- listings ----------

export const ListingStatus = Schema.Literals(['available', 'pending', 'sold', 'unknown']);
export type ListingStatus = typeof ListingStatus.Type;

export const Price = Schema.Struct({
  /** Numeric amount in major units (dollars), null when unknown. 0 means free. */
  amount: Schema.NullOr(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Display string as Facebook formats it, e.g. "$60", "Free", "$1,200". */
  formatted: Text(100),
  currency: Schema.NullOr(Text(10)),
});
export type Price = typeof Price.Type;

/** 'IN_PERSON' | 'SHIPPING' | 'DOOR_PICKUP' | other strings Facebook sends. */
export const DeliveryType = Text(50);
export type DeliveryType = 'IN_PERSON' | 'SHIPPING' | 'DOOR_PICKUP' | (string & {});

export const ListingSummary = Schema.Struct({
  id: ListingId,
  title: Text(500),
  price: Price,
  /** Original price when the seller marked it down, e.g. "$80". */
  previousPrice: Schema.NullOr(Text(100)),
  imageUrl: Schema.NullOr(HttpUrl),
  /** Human location, e.g. "Brooklyn, NY". */
  location: Schema.NullOr(Text(200)),
  /** Unix epoch milliseconds, null when Facebook didn't include it. */
  createdAt: Schema.NullOr(EpochMillis),
  status: ListingStatus,
  sellerId: Schema.NullOr(FbId),
  sellerName: Schema.NullOr(Text(200)),
  deliveryTypes: Schema.Array(DeliveryType).check(Schema.isMaxLength(10)),
  categoryId: Schema.NullOr(Text(64)),
  /** Canonical facebook.com URL for the listing (used only for the remote view). */
  url: HttpUrl,
});
export type ListingSummary = typeof ListingSummary.Type;

export const SellerInfo = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
  /** 0-5 average, null when private or absent. */
  rating: Schema.NullOr(Schema.Finite),
  ratingCount: Schema.NullOr(NonNegativeInt),
  /** e.g. "Joined Facebook in 2012" when available. */
  joinedText: Schema.NullOr(Schema.String),
});
export type SellerInfo = typeof SellerInfo.Type;

export const ListingAttribute = Schema.Struct({ label: Schema.String, value: Schema.String });
export type ListingAttribute = typeof ListingAttribute.Type;

export const ListingDetail = Schema.Struct({
  ...ListingSummary.fields,
  description: Schema.String,
  photos: Schema.Array(Schema.String),
  /** e.g. "Used - like new". */
  condition: Schema.NullOr(Schema.String),
  attributes: Schema.Array(ListingAttribute),
  /** e.g. "Bicycles". */
  categoryName: Schema.NullOr(Schema.String),
  seller: Schema.NullOr(SellerInfo),
  shippingOffered: Schema.Boolean,
  /** Logged in and Facebook allows messaging this listing. */
  canMessage: Schema.Boolean,
  /** The logged-in user already messaged this seller about this listing. */
  hasMessaged: Schema.Boolean,
  isViewerSeller: Schema.Boolean,
});
export type ListingDetail = typeof ListingDetail.Type;

// ---------- search ----------

export const SortBy = Schema.Literals([
  'best_match',
  'creation_time_descend',
  'price_ascend',
  'price_descend',
  'distance_ascend',
]);
export type SortBy = typeof SortBy.Type;

export const Condition = Schema.Literals(['new', 'used_like_new', 'used_good', 'used_fair']);
export type Condition = typeof Condition.Type;

export const DaysSinceListed = Schema.Literals([1, 7, 30]);
export type DaysSinceListed = typeof DaysSinceListed.Type;

export const DeliveryMethod = Schema.Literals(['all', 'local_pick_up', 'shipping']);
export type DeliveryMethod = typeof DeliveryMethod.Type;

const SearchParamsFields = {
  /** Free-text query. Empty/absent means browse (category or nearby). */
  query: Schema.optionalKey(TrimmedText(200)),
  /** Marketplace category slug, e.g. "bicycles", "vehicles". */
  category: Schema.optionalKey(CategorySlug),
  /** Absent means the account's own Marketplace location (or IP-based when logged out). */
  location: Schema.optionalKey(LocationId),
  radiusKm: Schema.optionalKey(RadiusKm),
  minPrice: Schema.optionalKey(WholeDollars),
  maxPrice: Schema.optionalKey(WholeDollars),
  sortBy: Schema.optionalKey(SortBy),
  daysSinceListed: Schema.optionalKey(DaysSinceListed),
  conditions: Schema.optionalKey(Schema.Array(Condition).check(Schema.isMaxLength(8))),
  delivery: Schema.optionalKey(DeliveryMethod),
  /** Only exact matches for the query. */
  exact: Schema.optionalKey(Schema.Boolean),
};

const SearchParamsShape = Schema.Struct(SearchParamsFields).check(
  Schema.makeFilter((p) =>
    p.minPrice !== undefined && p.maxPrice !== undefined && p.minPrice > p.maxPrice
      ? { path: ['minPrice'], issue: 'must not be more than maxPrice' }
      : undefined,
  ),
);

type SearchParamsShape = typeof SearchParamsShape.Type;

/** Drop an empty query and duplicate conditions so stored params compare and serialize cleanly. */
export function normalizeSearchParams(params: SearchParamsShape): SearchParamsShape {
  const { query, conditions, ...rest } = params;
  return {
    ...rest,
    ...(query !== undefined && query !== '' ? { query } : {}),
    ...(conditions !== undefined && conditions.length > 0 ? { conditions: [...new Set(conditions)] } : {}),
  };
}

/**
 * Search filters. Decoding trims the query, drops it when empty, and de-duplicates conditions.
 * Unknown keys are dropped.
 */
export const SearchParams = SearchParamsShape.pipe(
  Schema.decodeTo(
    Schema.toType(SearchParamsShape),
    SchemaTransformation.transform({ decode: normalizeSearchParams, encode: (p) => p }),
  ),
);
export type SearchParams = typeof SearchParams.Type;

export const SearchLocationInfo = Schema.Struct({
  /** e.g. "New York, New York". */
  name: Schema.NullOr(Schema.String),
  latitude: Schema.NullOr(Schema.Finite),
  longitude: Schema.NullOr(Schema.Finite),
  radiusKm: Schema.NullOr(Schema.Finite),
});
export type SearchLocationInfo = typeof SearchLocationInfo.Type;

export const SearchResult = Schema.Struct({
  /** Opaque handle for fetching the next page; null when there is no next page. */
  sessionId: Schema.NullOr(Schema.String),
  /** Listings after local filtering (hidden listings, blocked sellers, excluded keywords). */
  listings: Schema.Array(ListingSummary),
  hasMore: Schema.Boolean,
  location: Schema.NullOr(SearchLocationInfo),
  /** How many listings in this page were removed by local filtering. */
  filteredCount: NonNegativeInt,
});
export type SearchResult = typeof SearchResult.Type;

export const LocationOption = Schema.Struct({
  /** Facebook city page id, usable as SearchParams.location. */
  id: Schema.String,
  /** e.g. "Denver, Colorado". */
  name: Schema.String,
  /** e.g. "City" or "Downtown Denver, CO". */
  subtitle: Schema.NullOr(Schema.String),
  latitude: Schema.NullOr(Schema.Finite),
  longitude: Schema.NullOr(Schema.Finite),
});
export type LocationOption = typeof LocationOption.Type;

export const Category = Schema.Struct({ slug: Schema.String, name: Schema.String });
export type Category = typeof Category.Type;

// ---------- server-function inputs for browsing ----------

export const LoadMoreRequest = Schema.Struct({ sessionId: SearchSessionId });
export type LoadMoreRequest = typeof LoadMoreRequest.Type;

export const ListingRequest = Schema.Struct({ id: ListingId });
export type ListingRequest = typeof ListingRequest.Type;

/** Location typeahead. Queries shorter than 2 characters return []. */
export const LocationsRequest = Schema.Struct({ q: TrimmedText(100) });
export type LocationsRequest = typeof LocationsRequest.Type;

// ---------- auth (Facebook) ----------

export const AuthState = Schema.Literals([
  /** No Facebook session. Browsing still works (logged out). */
  'logged_out',
  /** Credential login in progress. */
  'logging_in',
  /** Facebook asked for a 2FA / login code; submit it with submitLoginCode. */
  'needs_code',
  /** Facebook wants approval from another device; poll status. */
  'needs_approval',
  /** The remote login view is open (was: the headed login window); poll status until it closes. */
  'window_open',
  'logged_in',
  'error',
]);
export type AuthState = typeof AuthState.Type;

export const AuthStatus = Schema.Struct({
  state: AuthState,
  userId: Schema.NullOr(Schema.String),
  userName: Schema.NullOr(Schema.String),
  /** Human-readable detail for needs_code / needs_approval / error. */
  message: Schema.NullOr(Schema.String),
});
export type AuthStatus = typeof AuthStatus.Type;

export const AuthStatusRequest = Schema.Struct({
  /** Do a live check against Facebook (slower) instead of trusting the saved cookies. */
  verify: Schema.optionalKey(Schema.Boolean),
});
export type AuthStatusRequest = typeof AuthStatusRequest.Type;

/** Facebook credentials. The password is typed into Facebook's form and never logged, stored, or returned. */
export const LoginRequest = Schema.Struct({
  email: RequiredText(320),
  password: Schema.String.check(Schema.isMinLength(1, { message: 'is required' }), Schema.isMaxLength(1000)),
});
export type LoginRequest = typeof LoginRequest.Type;

export const LoginCodeRequest = Schema.Struct({ code: RequiredText(32) });
export type LoginCodeRequest = typeof LoginCodeRequest.Type;

// ---------- app password (APP_PASSWORD gate; unrelated to Facebook) ----------

export const AppAuthStatus = Schema.Struct({ required: Schema.Boolean, authenticated: Schema.Boolean });
export type AppAuthStatus = typeof AppAuthStatus.Type;

export const AppLoginRequest = Schema.Struct({
  password: Schema.String.check(Schema.isMinLength(1, { message: 'is required' }), Schema.isMaxLength(1000)),
});
export type AppLoginRequest = typeof AppLoginRequest.Type;

// ---------- messaging ----------

export const MAX_MESSAGE_LENGTH = 1000;

export const SendMessageRequest = Schema.Struct({ text: RequiredText(MAX_MESSAGE_LENGTH) });
export type SendMessageRequest = typeof SendMessageRequest.Type;

/** Server-function input: the legacy route's path id + body. */
export const SendMessageInput = Schema.Struct({ listingId: ListingId, ...SendMessageRequest.fields });
export type SendMessageInput = typeof SendMessageInput.Type;

export const SendMessageResult = Schema.Struct({
  ok: Schema.Boolean,
  /** Human-readable outcome, e.g. "Message sent" or why it failed. */
  message: Schema.String,
  /** When true the UI should offer to open the listing in the remote view instead. */
  fallbackToWindow: Schema.Boolean,
});
export type SendMessageResult = typeof SendMessageResult.Type;

// ---------- local data ----------

const SavedSearchName = RequiredText(100);

export const SavedSearch = Schema.Struct({
  id: SavedSearchId,
  name: Schema.String,
  params: SearchParams,
  createdAt: EpochMillis,
  /** Background checks only run when true. */
  autoCheck: Schema.Boolean,
  lastCheckedAt: Schema.NullOr(EpochMillis),
  lastViewedAt: Schema.NullOr(EpochMillis),
  /** Listings first seen after lastViewedAt. */
  newCount: NonNegativeInt,
});
export type SavedSearch = typeof SavedSearch.Type;

export const SavedSearchInput = Schema.Struct({
  name: SavedSearchName,
  params: SearchParams,
  /** Defaults to true. */
  autoCheck: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
});
export type SavedSearchInput = typeof SavedSearchInput.Type;
export type SavedSearchInputEncoded = typeof SavedSearchInput.Encoded;

export const SavedSearchPatch = Schema.Struct({
  name: Schema.optionalKey(SavedSearchName),
  params: Schema.optionalKey(SearchParams),
  autoCheck: Schema.optionalKey(Schema.Boolean),
});
export type SavedSearchPatch = typeof SavedSearchPatch.Type;

/** Server-function input for updates: the legacy route's path id + body. */
export const UpdateSavedSearchInput = Schema.Struct({ id: SavedSearchId, patch: SavedSearchPatch });
export type UpdateSavedSearchInput = typeof UpdateSavedSearchInput.Type;

export const SavedSearchIdRequest = Schema.Struct({ id: SavedSearchId });
export type SavedSearchIdRequest = typeof SavedSearchIdRequest.Type;

export const SavedSearchRunResult = Schema.Struct({
  savedSearch: SavedSearch,
  /** Listings first seen after lastViewedAt, newest first. */
  newListings: Schema.Array(ListingSummary),
});
export type SavedSearchRunResult = typeof SavedSearchRunResult.Type;

export const Favorite = Schema.Struct({
  listing: ListingSummary,
  savedAt: EpochMillis,
  /** Price when favorited, to show drops. */
  originalPrice: Price,
  lastCheckedAt: Schema.NullOr(EpochMillis),
  note: Schema.NullOr(Schema.String),
});
export type Favorite = typeof Favorite.Type;

const FavoriteNote = Schema.NullOr(TrimmedText(1000)).pipe(
  Schema.decodeTo(
    Schema.NullOr(Schema.String),
    SchemaTransformation.transform({ decode: (note) => (note === '' ? null : note), encode: (note) => note }),
  ),
  Schema.withDecodingDefaultKey(Effect.succeed(null)),
);

export const FavoriteInput = Schema.Struct({
  listing: ListingSummary,
  /** Trimmed; empty or absent becomes null. */
  note: FavoriteNote,
});
export type FavoriteInput = typeof FavoriteInput.Type;
export type FavoriteInputEncoded = typeof FavoriteInput.Encoded;

export const ListingIdRequest = Schema.Struct({ listingId: ListingId });
export type ListingIdRequest = typeof ListingIdRequest.Type;

export const BlockedSeller = Schema.Struct({ id: Schema.String, name: Schema.String, blockedAt: EpochMillis });
export type BlockedSeller = typeof BlockedSeller.Type;

export const BlockedSellerInput = Schema.Struct({
  id: FbId,
  name: TrimmedText(200).pipe(Schema.withDecodingDefaultKey(Effect.succeed(''))),
});
export type BlockedSellerInput = typeof BlockedSellerInput.Type;

export const SellerIdRequest = Schema.Struct({ id: FbId });
export type SellerIdRequest = typeof SellerIdRequest.Type;

export const HiddenListing = Schema.Struct({ id: Schema.String, title: Schema.String, hiddenAt: EpochMillis });
export type HiddenListing = typeof HiddenListing.Type;

export const HiddenListingInput = Schema.Struct({
  id: ListingId,
  title: TrimmedText(500).pipe(Schema.withDecodingDefaultKey(Effect.succeed(''))),
});
export type HiddenListingInput = typeof HiddenListingInput.Type;

export const HiddenListingIdRequest = Schema.Struct({ id: ListingId });
export type HiddenListingIdRequest = typeof HiddenListingIdRequest.Type;

// ---------- settings ----------

/** Trim, lowercase, collapse inner whitespace, drop empties and duplicates. */
export function normalizeKeywords(keywords: readonly string[]): string[] {
  const out = new Set<string>();
  for (const k of keywords) {
    const v = k.trim().toLowerCase().replace(/\s+/g, ' ');
    if (v) out.add(v);
  }
  return [...out];
}

export const DefaultLocation = Schema.Struct({ id: LocationId, name: RequiredText(200) });
export type DefaultLocation = typeof DefaultLocation.Type;

const SettingsFields = {
  /** Default location for searches; null = account location. */
  defaultLocation: Schema.NullOr(DefaultLocation),
  defaultRadiusKm: Schema.NullOr(RadiusKm),
  /** Case-insensitive words; listings whose title contains any are filtered out. Normalized, at most 100. */
  excludedKeywords: Schema.Array(Text(100))
    .check(Schema.isMaxLength(1000))
    .pipe(
      Schema.decodeTo(
        Schema.Array(Schema.String).check(Schema.isMaxLength(100, { message: 'at most 100 keywords' })),
        SchemaTransformation.transform<readonly string[], readonly string[]>({
          decode: normalizeKeywords,
          encode: (k) => k,
        }),
      ),
    ),
  /** Background check interval for saved searches + favorites. 0 = off, else 15..1440. */
  checkIntervalMinutes: Schema.Int.check(
    Schema.makeFilter((n: number) => n === 0 || (n >= 15 && n <= 1440), {
      message: 'must be 0 (off) or between 15 and 1440',
    }),
  ),
  /** Show a gentle "you've been browsing a while" nudge after N minutes. 0 = off. */
  sessionNudgeMinutes: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 240 })),
  /** Ask the browser to show a desktop notification when saved searches find new listings. */
  desktopNotifications: Schema.Boolean,
};

export const Settings = Schema.Struct(SettingsFields);
export type Settings = typeof Settings.Type;

/** PUT /api/settings body: any subset of Settings. */
export const SettingsPatch = Schema.Struct({
  defaultLocation: Schema.optionalKey(SettingsFields.defaultLocation),
  defaultRadiusKm: Schema.optionalKey(SettingsFields.defaultRadiusKm),
  excludedKeywords: Schema.optionalKey(SettingsFields.excludedKeywords),
  checkIntervalMinutes: Schema.optionalKey(SettingsFields.checkIntervalMinutes),
  sessionNudgeMinutes: Schema.optionalKey(SettingsFields.sessionNudgeMinutes),
  desktopNotifications: Schema.optionalKey(SettingsFields.desktopNotifications),
});
export type SettingsPatch = typeof SettingsPatch.Type;

export const DEFAULT_SETTINGS: Settings = {
  defaultLocation: null,
  defaultRadiusKm: null,
  excludedKeywords: [],
  checkIntervalMinutes: 60,
  sessionNudgeMinutes: 30,
  desktopNotifications: false,
};

// ---------- Facebook groups ----------
// Groups are read as the browser's Facebook account (private groups only show to members), so
// every groups server function needs a logged-in browser (NOT_LOGGED_IN otherwise).

/** A Facebook group's numeric id. */
export const GroupId = Schema.String.check(Schema.isPattern(/^\d{1,25}$/, { message: 'must be a numeric group id' }));
export type GroupId = typeof GroupId.Type;

/** A group post's numeric id (Facebook's `post_id`). */
export const GroupPostId = Schema.String.check(Schema.isPattern(/^\d{1,25}$/, { message: 'must be a numeric post id' }));
export type GroupPostId = typeof GroupPostId.Type;

/** A group as pasted by the user: its numeric id or its vanity name ("okpuppies"). Never just dots. */
export const GroupRef = Schema.String.check(
  Schema.isPattern(/^(?!\.+$)[A-Za-z0-9._-]{1,100}$/, { message: 'must be a group id or name' }),
);
export type GroupRef = typeof GroupRef.Type;

/** A group the account belongs to (the groups list). */
export const GroupSummary = Schema.Struct({
  id: GroupId,
  name: Text(300),
  url: HttpUrl,
  imageUrl: Schema.NullOr(HttpUrl),
  /** When something was last posted, when Facebook says. */
  lastPostAt: Schema.NullOr(EpochMillis),
});
export type GroupSummary = typeof GroupSummary.Type;

/** A post's or comment's author. */
export const GroupPerson = Schema.Struct({
  /** Facebook user id; null for anonymous posts. */
  id: Schema.NullOr(FbId),
  name: Text(200),
  url: Schema.NullOr(HttpUrl),
  imageUrl: Schema.NullOr(HttpUrl),
});
export type GroupPerson = typeof GroupPerson.Type;

export const MAX_POST_IMAGES = 30;

export const GroupPost = Schema.Struct({
  id: GroupPostId,
  groupId: GroupId,
  groupName: Schema.NullOr(Text(300)),
  author: Schema.NullOr(GroupPerson),
  /** The post's text ('' for photo-only posts). */
  text: Text(10_000),
  /** Unix epoch milliseconds, null when Facebook didn't include it. */
  createdAt: Schema.NullOr(EpochMillis),
  /** Photo URLs in post order (Facebook's signed CDN URLs: they expire after a while). */
  images: Schema.Array(HttpUrl).check(Schema.isMaxLength(MAX_POST_IMAGES)),
  /** Has a video (faceslop shows a link to it instead of playing it). */
  hasVideo: Schema.Boolean,
  commentCount: Schema.NullOr(NonNegativeInt),
  /** Canonical facebook.com URL of the post (used only for the remote view and webhooks). */
  url: HttpUrl,
});
export type GroupPost = typeof GroupPost.Type;

export const GroupComment = Schema.Struct({
  id: Text(64),
  author: Schema.NullOr(GroupPerson),
  text: Text(8_000),
  createdAt: Schema.NullOr(EpochMillis),
  replyCount: NonNegativeInt,
});
export type GroupComment = typeof GroupComment.Type;

export const GroupPostDetail = Schema.Struct({
  ...GroupPost.fields,
  /** The top-level comments Facebook shows first (not every comment of a busy post). */
  comments: Schema.Array(GroupComment),
  /** Facebook lets this account comment (commenting happens in the live view). */
  canComment: Schema.Boolean,
});
export type GroupPostDetail = typeof GroupPostDetail.Type;

/** A group's identity as its page shows it. */
export const GroupInfo = Schema.Struct({ id: GroupId, name: Schema.NullOr(Text(300)) });
export type GroupInfo = typeof GroupInfo.Type;

/** One page of a group's newest posts. */
export const GroupFeedPage = Schema.Struct({
  /** Handle for loadMoreGroupPosts(); null when there are no more pages. */
  sessionId: Schema.NullOr(Schema.String),
  group: GroupInfo,
  posts: Schema.Array(GroupPost),
  hasMore: Schema.Boolean,
});
export type GroupFeedPage = typeof GroupFeedPage.Type;

export const GroupRequest = Schema.Struct({ groupId: GroupId });
export type GroupRequest = typeof GroupRequest.Type;

export const GroupPostRequest = Schema.Struct({ groupId: GroupId, postId: GroupPostId });
export type GroupPostRequest = typeof GroupPostRequest.Type;

/** A pasted group URL ("https://www.facebook.com/groups/okpuppies/") or a bare id/name. */
export const ResolveGroupRequest = Schema.Struct({ ref: TrimmedText(500) });
export type ResolveGroupRequest = typeof ResolveGroupRequest.Type;

/** The group id or vanity name in a pasted group URL or bare reference, or null. */
export function parseGroupRef(input: string): GroupRef | null {
  const text = input.trim();
  const fromUrl = /^(?:https?:\/\/)?(?:[a-z]+\.)?facebook\.com\/groups\/([A-Za-z0-9._-]{1,100})(?:[/?#]|$)/i.exec(text)?.[1];
  const ref = fromUrl ?? text;
  // Only dots would be a path segment ("..") rather than a group.
  return /^(?!\.+$)[A-Za-z0-9._-]{1,100}$/.test(ref) ? ref : null;
}

// ---------- group watches ----------

/** Group watch primary key (positive integer). */
export const GroupWatchId = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999_999_999_999 }));
export type GroupWatchId = typeof GroupWatchId.Type;

/** Normalized keyword lists (matched at the start of a word, ignoring case and accents), at most 50. */
const WatchKeywords = Schema.Array(Text(100))
  .check(Schema.isMaxLength(500))
  .pipe(
    Schema.decodeTo(
      Schema.Array(Schema.String).check(Schema.isMaxLength(50, { message: 'at most 50 keywords' })),
      SchemaTransformation.transform<readonly string[], readonly string[]>({ decode: normalizeKeywords, encode: (k) => k }),
    ),
  );

export const MIN_WATCH_INTERVAL_MINUTES = 5;
export const DEFAULT_WATCH_INTERVAL_MINUTES = 15;

/** How often a watched group is checked, in minutes. */
export const WatchIntervalMinutes = Schema.Int.check(
  Schema.isBetween({ minimum: MIN_WATCH_INTERVAL_MINUTES, maximum: 1440 }, { message: 'must be between 5 and 1440' }),
);

export const GroupWatch = Schema.Struct({
  id: GroupWatchId,
  groupId: GroupId,
  groupName: Schema.String,
  /** A new post matches when its text contains any of these; empty = every new post matches. */
  keywords: Schema.Array(Schema.String),
  /** A post containing any of these never matches. */
  excludeKeywords: Schema.Array(Schema.String),
  intervalMinutes: Schema.Int,
  /** Background checks (and webhooks) only run when true. */
  enabled: Schema.Boolean,
  createdAt: EpochMillis,
  lastCheckedAt: Schema.NullOr(EpochMillis),
  /** Why the last check failed (cleared by the next good one). */
  lastError: Schema.NullOr(Schema.String),
  /** False until the first check recorded what was already posted (nothing before it counts as new). */
  seeded: Schema.Boolean,
  /** Matching posts found since the matches were last viewed. */
  newMatchCount: NonNegativeInt,
});
export type GroupWatch = typeof GroupWatch.Type;

export const GroupWatchInput = Schema.Struct({
  groupId: GroupId,
  groupName: RequiredText(300),
  keywords: WatchKeywords.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  excludeKeywords: WatchKeywords.pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  intervalMinutes: WatchIntervalMinutes.pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_WATCH_INTERVAL_MINUTES))),
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
});
export type GroupWatchInput = typeof GroupWatchInput.Type;
export type GroupWatchInputEncoded = typeof GroupWatchInput.Encoded;

export const GroupWatchPatch = Schema.Struct({
  keywords: Schema.optionalKey(WatchKeywords),
  excludeKeywords: Schema.optionalKey(WatchKeywords),
  intervalMinutes: Schema.optionalKey(WatchIntervalMinutes),
  enabled: Schema.optionalKey(Schema.Boolean),
});
export type GroupWatchPatch = typeof GroupWatchPatch.Type;
export type GroupWatchPatchEncoded = typeof GroupWatchPatch.Encoded;

export const UpdateGroupWatchInput = Schema.Struct({ id: GroupWatchId, patch: GroupWatchPatch });
export type UpdateGroupWatchInput = typeof UpdateGroupWatchInput.Type;

export const GroupWatchIdRequest = Schema.Struct({ id: GroupWatchId });
export type GroupWatchIdRequest = typeof GroupWatchIdRequest.Type;

/** Mark a watch's matches seen up to the newest one shown (its matchedAt). */
export const ViewGroupWatchMatchesRequest = Schema.Struct({ id: GroupWatchId, upTo: EpochMillis });
export type ViewGroupWatchMatchesRequest = typeof ViewGroupWatchMatchesRequest.Type;

/** A new post that matched a watch. */
export const GroupWatchMatch = Schema.Struct({
  watchId: GroupWatchId,
  post: GroupPost,
  /** The watch keywords found in the post ([] when the watch has none). */
  matchedKeywords: Schema.Array(Schema.String),
  matchedAt: EpochMillis,
});
export type GroupWatchMatch = typeof GroupWatchMatch.Type;

export const GroupWatchCheckResult = Schema.Struct({
  watch: GroupWatch,
  /** Posts seen for the first time by this check. */
  newPosts: NonNegativeInt,
  /** Of those, the ones that matched (and went to the webhooks). */
  matches: Schema.Array(GroupWatchMatch),
});
export type GroupWatchCheckResult = typeof GroupWatchCheckResult.Type;

// ---------- webhooks ----------

/** Webhook primary key (positive integer). */
export const WebhookId = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 999_999_999_999 }));
export type WebhookId = typeof WebhookId.Type;

/** Where a webhook POSTs: an absolute http(s) URL without credentials. */
export const WebhookUrl = Schema.Trim.check(
  Schema.isMaxLength(2000),
  Schema.makeFilter(
    (value: string) => {
      let url: URL;
      try {
        url = new URL(value);
      } catch {
        return 'must be a URL';
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'must be an http(s) URL';
      if (url.username !== '' || url.password !== '') return 'must not contain a user name or password';
      return url.hostname === '' ? 'must have a host' : undefined;
    },
    { message: 'must be an http(s) URL' },
  ),
);

export const WebhookEvent = Schema.Literals(['group.post', 'test']);
export type WebhookEvent = typeof WebhookEvent.Type;

export const WebhookDeliveryStatus = Schema.Literals(['pending', 'delivered', 'failed']);
export type WebhookDeliveryStatus = typeof WebhookDeliveryStatus.Type;

export const WebhookDelivery = Schema.Struct({
  id: Schema.Int,
  webhookId: WebhookId,
  event: WebhookEvent,
  /** One line: what it was about ("New post in Oklahoma small puppies"). */
  summary: Schema.String,
  status: WebhookDeliveryStatus,
  attempts: NonNegativeInt,
  /** The last attempt's HTTP status (null before any answer). */
  httpStatus: Schema.NullOr(Schema.Int),
  error: Schema.NullOr(Schema.String),
  createdAt: EpochMillis,
  lastAttemptAt: Schema.NullOr(EpochMillis),
  /** When a pending delivery is tried again. */
  nextAttemptAt: Schema.NullOr(EpochMillis),
});
export type WebhookDelivery = typeof WebhookDelivery.Type;

export const Webhook = Schema.Struct({
  id: WebhookId,
  name: Schema.String,
  url: Schema.String,
  /** HMAC-SHA256 key for the X-Faceslop-Signature header (only ever shown to its owner). */
  secret: Schema.String,
  enabled: Schema.Boolean,
  createdAt: EpochMillis,
  lastDelivery: Schema.NullOr(WebhookDelivery),
});
export type Webhook = typeof Webhook.Type;

const WebhookName = RequiredText(100);

export const WebhookInput = Schema.Struct({
  name: WebhookName,
  url: WebhookUrl,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
});
export type WebhookInput = typeof WebhookInput.Type;
export type WebhookInputEncoded = typeof WebhookInput.Encoded;

export const WebhookPatch = Schema.Struct({
  name: Schema.optionalKey(WebhookName),
  url: Schema.optionalKey(WebhookUrl),
  enabled: Schema.optionalKey(Schema.Boolean),
  /** Replace the signing secret with a new random one. */
  rotateSecret: Schema.optionalKey(Schema.Boolean),
});
export type WebhookPatch = typeof WebhookPatch.Type;

export const UpdateWebhookInput = Schema.Struct({ id: WebhookId, patch: WebhookPatch });
export type UpdateWebhookInput = typeof UpdateWebhookInput.Type;

export const WebhookIdRequest = Schema.Struct({ id: WebhookId });
export type WebhookIdRequest = typeof WebhookIdRequest.Type;

export const WebhookTestResult = Schema.Struct({
  ok: Schema.Boolean,
  httpStatus: Schema.NullOr(Schema.Int),
  error: Schema.NullOr(Schema.String),
});
export type WebhookTestResult = typeof WebhookTestResult.Type;

/**
 * The JSON body of a "group.post" webhook (version 1). Headers: X-Faceslop-Event,
 * X-Faceslop-Delivery (the delivery id; retries reuse it), X-Faceslop-Timestamp (unix seconds) and
 * X-Faceslop-Signature: "sha256=" + hex HMAC-SHA256(secret, `${timestamp}.${body}`).
 */
export interface GroupPostWebhookPayload {
  readonly version: 1;
  readonly event: 'group.post';
  readonly deliveryId: string;
  /** ISO 8601. */
  readonly sentAt: string;
  readonly watch: {
    readonly id: GroupWatchId;
    readonly groupId: GroupId;
    readonly groupName: string;
    readonly matchedKeywords: readonly string[];
  };
  readonly post: {
    readonly id: GroupPostId;
    readonly url: string;
    readonly text: string;
    readonly author: { readonly name: string; readonly url: string | null } | null;
    /** ISO 8601, null when unknown. */
    readonly createdAt: string | null;
    readonly images: readonly string[];
    readonly hasVideo: boolean;
    readonly commentCount: number | null;
  };
}

/** The JSON body of a "test" webhook (the "Send test" button). */
export interface TestWebhookPayload {
  readonly version: 1;
  readonly event: 'test';
  readonly deliveryId: string;
  readonly sentAt: string;
  readonly message: string;
}

// ---------- misc ----------

export const Ok = Schema.Struct({ ok: Schema.Literal(true) });
export type Ok = typeof Ok.Type;
export const OK: Ok = { ok: true };
