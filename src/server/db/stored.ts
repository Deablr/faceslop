// Schemas for the JSON the database stores (listings, prices, search params, settings values).
// OWNER: server builder.
//
// Stored rows are decoded leniently, like legacy db.ts: a listing needs its id, title, price and
// url; any other field that is missing gets its empty value, and length/format limits are not
// re-checked (Facebook data that was fine when recorded stays readable). Rows whose JSON is
// unusable are skipped by the repositories instead of failing the whole list.
import '@tanstack/react-start/server-only';
import { Array as Arr, Effect, Option, Schema } from 'effect';
import {
  DEFAULT_SETTINGS,
  ListingStatus,
  SearchParams,
  Settings,
  type ListingSummary,
  type Price,
  type SettingsPatch,
} from '@/shared/domain';

/**
 * Decode rows one at a time, skipping the ones that don't decode (unusable stored JSON) instead of
 * failing the whole query.
 */
export const decodeRowsSkippingBad = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) => {
  const decode = Schema.decodeUnknownOption(schema);
  return (rows: readonly unknown[]): S['Type'][] => Arr.getSomes(rows.map((row) => decode(row)));
};

const orNull = <S extends Schema.Top>(schema: S) =>
  Schema.NullOr(schema).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(null)));

export const StoredPrice = Schema.Struct({
  amount: Schema.NullOr(Schema.Finite),
  formatted: Schema.String,
  currency: orNull(Schema.String),
});

export const StoredListing = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  price: StoredPrice,
  previousPrice: orNull(Schema.String),
  imageUrl: orNull(Schema.String),
  location: orNull(Schema.String),
  createdAt: orNull(Schema.Finite),
  status: ListingStatus.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed('unknown' as const))),
  sellerId: orNull(Schema.String),
  sellerName: orNull(Schema.String),
  deliveryTypes: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([]))),
  categoryId: orNull(Schema.String),
  url: Schema.String,
});

/** `listing_json` columns. */
export const ListingJson = Schema.fromJsonString(StoredListing);
/** `original_price_json` column. */
export const PriceJson = Schema.fromJsonString(StoredPrice);

const encodeListing = Schema.encodeSync(ListingJson);
const encodePrice = Schema.encodeSync(PriceJson);
const decodePrice = Schema.decodeUnknownOption(PriceJson);

/** Listing -> `listing_json`. */
export const listingToJson = (listing: ListingSummary): string => encodeListing(listing);
/** Price -> `original_price_json`. */
export const priceToJson = (price: Price): string => encodePrice(price);
/** `original_price_json` -> Price, or `fallback` when it is unusable. */
export const priceFromJson = (json: string, fallback: Price): Price => Option.getOrElse(decodePrice(json), () => fallback);

/**
 * `params_json`: stored search params. Unusable JSON reads as `{}` (legacy parseParams), so the
 * saved search still lists and can be edited.
 */
export const SearchParamsJson = Schema.fromJsonString(SearchParams).pipe(
  Schema.catchDecoding(() => Effect.succeed(Option.some({}))),
);
export const searchParamsToJson = Schema.encodeSync(Schema.fromJsonString(SearchParams));

// ---------- settings (one row per key, JSON values) ----------

const storedSetting = <S extends Schema.Top>(schema: S, fallback: S['Type']) => {
  const json = Schema.fromJsonString(schema);
  // A value that fails its check is ignored (legacy settingCheckers), a missing key is the default.
  const lenient = Schema.catchDecoding<typeof json>(() => Effect.succeed(Option.some(fallback)))(json);
  return Schema.withDecodingDefaultTypeKey<typeof lenient>(Effect.succeed(fallback))(lenient);
};

/** `{ [key]: valueJson }` rows -> Settings; unknown keys are ignored. */
export const StoredSettings = Schema.Struct({
  defaultLocation: storedSetting(Settings.fields.defaultLocation, DEFAULT_SETTINGS.defaultLocation),
  defaultRadiusKm: storedSetting(Settings.fields.defaultRadiusKm, DEFAULT_SETTINGS.defaultRadiusKm),
  excludedKeywords: storedSetting(Settings.fields.excludedKeywords, DEFAULT_SETTINGS.excludedKeywords),
  checkIntervalMinutes: storedSetting(Settings.fields.checkIntervalMinutes, DEFAULT_SETTINGS.checkIntervalMinutes),
  sessionNudgeMinutes: storedSetting(Settings.fields.sessionNudgeMinutes, DEFAULT_SETTINGS.sessionNudgeMinutes),
  desktopNotifications: storedSetting(Settings.fields.desktopNotifications, DEFAULT_SETTINGS.desktopNotifications),
});

/** A validated SettingsPatch -> `{ [key]: valueJson }` for the keys it sets. */
const SettingsPatchJson = Schema.Struct({
  defaultLocation: Schema.optionalKey(Schema.fromJsonString(Settings.fields.defaultLocation)),
  defaultRadiusKm: Schema.optionalKey(Schema.fromJsonString(Settings.fields.defaultRadiusKm)),
  excludedKeywords: Schema.optionalKey(Schema.fromJsonString(Settings.fields.excludedKeywords)),
  checkIntervalMinutes: Schema.optionalKey(Schema.fromJsonString(Settings.fields.checkIntervalMinutes)),
  sessionNudgeMinutes: Schema.optionalKey(Schema.fromJsonString(Settings.fields.sessionNudgeMinutes)),
  desktopNotifications: Schema.optionalKey(Schema.fromJsonString(Settings.fields.desktopNotifications)),
});
export const settingsPatchToJson: (patch: SettingsPatch) => Readonly<Record<string, string>> =
  Schema.encodeSync(SettingsPatchJson);
