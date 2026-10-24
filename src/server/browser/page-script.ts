// Run TypeScript functions inside a browser page (evaluate / init scripts). Shared by the
// Marketplace, Auth, Messaging and RemoteView services. Ported from legacy/src/server/fb/focus-script.ts.
//
// The function is sent as source text, so it must be self-contained: no references to
// module-level values (pass data through `args`). tsx/esbuild's `keepNames` wraps inner functions
// in a `__name(fn, "name")` helper that doesn't exist in the page (plain `page.evaluate(fn)` fails
// with "__name is not defined"). The wrapper below defines a no-op stand-in.
import '@tanstack/react-start/server-only';
import type { Page } from 'playwright';

/** A JS expression that calls `fn(...args)`; args are JSON-serialized. */
export function pageScript(fn: (...args: never[]) => unknown, ...args: unknown[]): string {
  const list = args.map((a) => (a === undefined ? 'undefined' : JSON.stringify(a))).join(', ');
  return `(() => { const __name = (f) => f; return (${fn.toString()})(${list}); })()`;
}

/** `page.evaluate` for a self-contained function, safe under tsx and Vite SSR. */
export function runInPage<A extends unknown[], R>(page: Page, fn: (...args: A) => R, ...args: A): Promise<Awaited<R>> {
  return page.evaluate<Awaited<R>>(pageScript(fn, ...args));
}
