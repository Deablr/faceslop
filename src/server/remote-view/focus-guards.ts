// Guards for the remote view: it only ever shows Marketplace (plus Facebook's login/2FA pages).
// Port of legacy/src/server/fb/focus-guards.ts (the "focused window" guards).
//
// Two layers, because Facebook is a single-page app:
// - context.route catches full page loads (typed URLs, form posts, location changes) to other pages.
// - an init script in every page hides Facebook's global chrome and blocks in-app navigation
//   (history.pushState, back/forward, link clicks, window.open, the Navigation API). It also
//   re-checks the URL each document lands on, which covers server-side redirects (Playwright
//   routes don't see redirect hops).
import '@tanstack/react-start/server-only';
import type { BrowserContext, Request } from 'playwright';
import { FB_ORIGIN } from '@/server/browser/Browser';

export const FOCUS_HOME = `${FB_ORIGIN}/marketplace/`;

/**
 * Whether a top-level navigation to `url` is allowed in the remote view.
 * Self-contained on purpose: the init script injects this exact function into pages.
 */
export function isAllowedFocusedUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  if (!['facebook.com', 'www.facebook.com', 'web.facebook.com', 'm.facebook.com'].includes(u.hostname)) return false;
  const path = u.pathname.toLowerCase();
  return [
    // All of Marketplace: browse, item, inbox, you/selling, create, profile.
    /^\/marketplace(\/|$)/,
    // A single chat thread (Marketplace conversations open here); not the Messenger inbox.
    /^\/messages\/(e2ee\/)?t\/[^/]+/,
    // Staying logged in: login, 2FA, checkpoints, account recovery, consent prompts.
    /^\/login(\.php)?(\/|$)/,
    /^\/(checkpoint|two_step_verification|two_factor|auth_platform|recover)(\/|$)/,
    /^\/privacy\/consent(\/|$)/,
    /^\/logout\.php$/,
  ].some((re) => re.test(path));
}

const FOCUS_CSS = `
div[role="banner"] { display: none !important; }
:root, .__fb-light-mode, .__fb-dark-mode { --header-height: 0px !important; }
div[role="button"][aria-label="New message"] { display: none !important; }
#faceslop-focus-notice {
  position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 2147483647;
  padding: 10px 16px; border-radius: 999px; background: rgba(28, 30, 33, 0.92); color: #fff;
  font: 14px/1.3 system-ui, -apple-system, sans-serif; pointer-events: none;
  transition: opacity 200ms ease; opacity: 0;
}`;

const NOTICE = 'Only Marketplace lives here, so that link stays closed.';

interface GuardConfig {
  readonly home: string;
  readonly css: string;
  readonly notice: string;
}

/** Runs at document start in every frame of the remote view (only the top frame does anything). */
function guardPage(allowed: (url: string) => boolean, cfg: GuardConfig): void {
  if (window.top !== window || !/^https?:$/.test(location.protocol)) return;

  const leave = () => {
    try {
      window.stop();
    } catch {
      // ignore
    }
    location.replace(cfg.home);
  };
  if (!allowed(location.href)) {
    leave();
    return;
  }

  const blocked = (url: string | URL | null | undefined): boolean => {
    if (url === null || url === undefined || url === '') return false;
    let target: URL;
    try {
      target = new URL(url, location.href);
    } catch {
      return false;
    }
    // javascript:, mailto:, blob: etc. aren't page navigations we police.
    return /^https?:$/.test(target.protocol) && !allowed(target.href);
  };

  // Hide Facebook's global header (feed, notifications, Messenger, search) and similar chrome.
  const addStyle = () => {
    if (document.getElementById('faceslop-focus-style')) return;
    // Typed non-null, but missing while the document is still being parsed.
    const root = (document.head as HTMLHeadElement | null) ?? document.documentElement;
    const style = document.createElement('style');
    style.id = 'faceslop-focus-style';
    style.textContent = cfg.css;
    root.appendChild(style);
  };
  // At document start there may be no root element yet.
  if ((document.documentElement as HTMLElement | null) === null) {
    new MutationObserver((_records, observer) => {
      if ((document.documentElement as HTMLElement | null) === null) return;
      observer.disconnect();
      addStyle();
    }).observe(document, { childList: true });
  } else {
    addStyle();
  }
  document.addEventListener('DOMContentLoaded', addStyle);

  let noticeTimer = 0;
  const notice = () => {
    if ((document.body as HTMLElement | null) === null) return;
    let el = document.getElementById('faceslop-focus-notice');
    if (!el) {
      el = document.createElement('div');
      el.id = 'faceslop-focus-notice';
      el.setAttribute('role', 'status');
      document.body.appendChild(el);
    }
    el.textContent = cfg.notice;
    el.style.opacity = '1';
    const shown = el;
    window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
      shown.style.opacity = '0';
    }, 2500);
  };

  // In-app (SPA) navigation goes through the History API.
  const wrapHistory = (name: 'pushState' | 'replaceState') => {
    const original = history[name].bind(history);
    history[name] = (data: unknown, unused: string, url?: string | URL | null) => {
      if (blocked(url)) {
        leave();
        return;
      }
      original(data, unused, url);
    };
  };
  wrapHistory('pushState');
  wrapHistory('replaceState');

  window.addEventListener(
    'popstate',
    (event) => {
      if (allowed(location.href)) return;
      event.stopImmediatePropagation();
      leave();
    },
    true,
  );

  // Clicks on links elsewhere on Facebook do nothing (with a short note) instead of navigating.
  const onClick = (event: MouseEvent) => {
    const link = event.target instanceof Element ? event.target.closest('a[href], area[href]') : null;
    if (!link || !blocked(link.getAttribute('href'))) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    notice();
  };
  window.addEventListener('click', onClick, true);
  window.addEventListener('auxclick', onClick, true);

  const open = window.open.bind(window);
  window.open = function (url?: string | URL, target?: string, features?: string) {
    if (blocked(url)) {
      notice();
      return null;
    }
    return open(url, target, features);
  };

  // Backstop for anything else (location.assign, forms, router internals) where supported.
  const navigation = (window as unknown as { readonly navigation?: EventTarget }).navigation;
  navigation?.addEventListener('navigate', (event) => {
    const nav = event as Event & { readonly destination?: { readonly url: string } };
    if (!nav.destination || !blocked(nav.destination.url)) return;
    if (nav.cancelable) nav.preventDefault();
    leave();
  });
}

/**
 * The init script source (exported for tests). Two self-contained functions are composed here,
 * so it builds the source itself instead of using `pageScript`, with the same `__name` stand-in
 * (see src/server/browser/page-script.ts).
 */
export function focusInitScript(): string {
  const cfg: GuardConfig = { home: FOCUS_HOME, css: FOCUS_CSS, notice: NOTICE };
  return `(() => {
  const __name = (f) => f;
  const allowed = ${isAllowedFocusedUrl.toString()};
  (${guardPage.toString()})(allowed, ${JSON.stringify(cfg)});
})();`;
}

/** Served in place of a blocked page; the init script (or the meta refresh) sends it straight back to Marketplace. */
const BLOCKED_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Marketplace only</title>
<meta http-equiv="refresh" content="0;url=${FOCUS_HOME}"></head>
<body style="font:16px system-ui,sans-serif;margin:4rem;color:#1c1e21">
Only Marketplace lives here. <a href="${FOCUS_HOME}">Back to Marketplace</a></body></html>`;

function isTopLevelDocument(request: Request): boolean {
  if (!request.isNavigationRequest() || request.resourceType() !== 'document') return false;
  try {
    return request.frame().parentFrame() === null;
  } catch {
    return false; // service worker requests have no frame
  }
}

/**
 * Lock a context to Marketplace (+ Facebook's login pages). Install before the first navigation.
 * Routes run last-registered-first, so routes added after this one see requests before it.
 */
export async function installFocusGuards(context: BrowserContext): Promise<void> {
  await context.addInitScript({ content: focusInitScript() });
  await context.route('**/*', (route) => {
    const request = route.request();
    if (!isTopLevelDocument(request) || isAllowedFocusedUrl(request.url())) return route.fallback();
    const blocked = new URL(request.url());
    console.info(`[remote-view] blocked navigation to ${blocked.host}${blocked.pathname}`);
    return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: BLOCKED_PAGE });
  });
}
