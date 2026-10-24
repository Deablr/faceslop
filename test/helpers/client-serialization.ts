// Decode a server-function response body exactly as the browser does: Seroval with Start's
// serialization adapters (from src/start.ts) in front of the router's default plugins.
import { createDefaultSerovalPlugins, makeSerovalPlugin } from '@tanstack/router-core/ssr/client';
import { fromCrossJSON, toJSONAsync } from 'seroval';
import { appErrorSerializationAdapter } from '@/shared/errors';

const clientPlugins = [makeSerovalPlugin(appErrorSerializationAdapter), ...createDefaultSerovalPlugins()];

/** Encode a server-function payload (`{ data }`) the way the client fetcher does. */
export async function encodePayload(data: unknown): Promise<string> {
  return JSON.stringify(await toJSONAsync({ data }, { plugins: clientPlugins }));
}

/** Decode a serialized server-function response (`{ result }` or `{ error }`), as serverFnFetcher does. */
export function decodeResponse(json: unknown): unknown {
  return fromCrossJSON(json as Parameters<typeof fromCrossJSON>[0], { refs: new Map(), plugins: clientPlugins });
}
