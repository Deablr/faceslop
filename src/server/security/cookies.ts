// Cookie header parsing for the bridge (src/server/bridge.ts reads the faceslop_session cookie
// with it). Kept apart from request-guard.ts, which imports the bridge.
import '@tanstack/react-start/server-only';

/** One cookie's value from a Cookie header. */
export function cookieValue(cookieHeader: string | null, name: string): string | undefined {
  if (cookieHeader === null) return undefined;
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=');
    if (eq !== -1 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}
