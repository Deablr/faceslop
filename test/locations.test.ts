// Pure parts of the location typeahead (no browser, no network).
import fs from 'node:fs';
import { Equal, Hash, Result } from 'effect';
import { describe, expect, it } from 'vitest';
import { parseGraphqlBody } from '@/server/marketplace/extract';
import {
  LOCATION_FRIENDLY_NAME,
  LocationQuery,
  isTypeaheadRequestFor,
  normalizeLocationQuery,
  readLocationOptions,
  typeaheadVariables,
} from '@/server/marketplace/locations';

const denverDocs = parseGraphqlBody(fs.readFileSync(new URL('./fixtures/locations-denver.graphql.txt', import.meta.url), 'utf8'));

describe('readLocationOptions', () => {
  it('lists actual cities first, otherwise keeps Facebook order', () => {
    const result = readLocationOptions(denverDocs);
    expect(Result.isSuccess(result)).toBe(true);
    const options = Result.getOrThrow(result);
    expect(options).toHaveLength(10);
    const firstNonCity = options.findIndex((o) => o.subtitle !== 'City');
    expect(options.slice(0, firstNonCity).every((o) => o.subtitle === 'City')).toBe(true);
    expect(options.slice(firstNonCity).every((o) => o.subtitle !== 'City')).toBe(true);
    expect(options.find((o) => o.id === '115590505119035')?.name).toBe('Denver, Colorado');
  });

  it('accepts an empty answer', () => {
    expect(Result.getOrThrow(readLocationOptions([{ data: { city_street_search: null } }]))).toEqual([]);
  });

  it('fails (FB_PARSE_FAILED) when the response is not an answer, with the GraphQL error when there is one', () => {
    const failed = readLocationOptions([{ errors: [{ message: 'PersistedQueryNotFound' }] }]);
    expect(Result.isFailure(failed) && failed.failure).toMatchObject({
      code: 'FB_PARSE_FAILED',
      message: 'Facebook location search failed: PersistedQueryNotFound',
    });
    const empty = readLocationOptions([{ data: {} }]);
    expect(Result.isFailure(empty) && empty.failure.message).toBe('Facebook location search returned no results field.');
  });
});

describe('typeahead requests', () => {
  it("sends the query the way Facebook's picker does", () => {
    expect(typeaheadVariables('Denver').params).toMatchObject({ query: 'Denver', caller: 'MARKETPLACE', viewer_coordinates: null });
  });

  it("recognizes Facebook's own typeahead request for a query", () => {
    const body = new URLSearchParams({
      fb_api_req_friendly_name: LOCATION_FRIENDLY_NAME,
      variables: JSON.stringify(typeaheadVariables('Denver')),
      doc_id: '1',
    }).toString();
    expect(isTypeaheadRequestFor(body, 'Denver')).toBe(true);
    expect(isTypeaheadRequestFor(body, 'Denve')).toBe(false);
    expect(isTypeaheadRequestFor(body.replace(LOCATION_FRIENDLY_NAME, 'OtherQuery'), 'Denver')).toBe(false);
    expect(isTypeaheadRequestFor('variables=%7Bbroken', 'Denver')).toBe(false);
    expect(isTypeaheadRequestFor(null, 'Denver')).toBe(false);
  });
});

describe('LocationQuery (cache key)', () => {
  it('normalizes whitespace', () => {
    expect(normalizeLocationQuery('  New   York \n')).toBe('New York');
  });

  it('compares case-insensitively but keeps the typed text', () => {
    const a = new LocationQuery('Denver');
    const b = new LocationQuery('dEnVeR');
    expect(Equal.equals(a, b)).toBe(true);
    expect(Hash.hash(a)).toBe(Hash.hash(b));
    expect(Equal.equals(a, new LocationQuery('Boulder'))).toBe(false);
    expect(a.text).toBe('Denver');
  });
});
