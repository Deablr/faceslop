// The remote view's Marketplace-only guards, exercised in a HEADLESS browser this test launches
// itself. Port of legacy/test/focus-guards.test.ts. The first suites run against a fake
// facebook.com (nothing leaves the machine); the last one loads the real logged-out Marketplace
// and is skipped when offline. FACESLOP_SKIP_BROWSER_TESTS=1 skips everything.
import { type Browser, type BrowserContext, type Page, chromium } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FOCUS_HOME, focusInitScript, installFocusGuards } from '@/server/remote-view/focus-guards';

const skip = process.env.FACESLOP_SKIP_BROWSER_TESTS === '1';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

let browser: Browser;
beforeAll(async () => {
  if (!skip) browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  if (!skip) await browser.close();
});

const fakePage = (path: string) => `<!doctype html><html><head><title>${path}</title>
<style>:root { --header-height: 56px; } div[role="banner"] { position: fixed; top: 0; height: var(--header-height); }</style></head>
<body><div role="banner"><a href="/">Facebook</a><a id="bell" href="/notifications">Notifications</a></div>
<div role="main" style="padding-top: var(--header-height)"><h1 id="path">${path}</h1>
<a id="item" href="/marketplace/item/123/">An item</a>
<a id="watch" href="/watch/">Watch</a>
<a id="shim" href="https://l.facebook.com/l.php?u=https%3A%2F%2Fexample.com">Outside link</a>
<a id="js" href="javascript:void(0)">JS link</a></div></body></html>`;

/** A fake facebook.com: every document names its path. Other hosts are aborted. */
async function fakeFacebook(context: BrowserContext): Promise<void> {
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (!/(^|\.)facebook\.com$/.test(url.hostname)) return route.abort();
    if (route.request().resourceType() !== 'document') return route.fulfill({ status: 204, body: '' });
    return route.fulfill({ contentType: 'text/html', body: fakePage(url.pathname) });
  });
}

async function guardedFakeContext(): Promise<BrowserContext> {
  const context = await browser.newContext({ userAgent: USER_AGENT });
  await fakeFacebook(context);
  await installFocusGuards(context); // registered last, so it sees requests first
  return context;
}

const pathOf = (page: Page) => new URL(page.url()).pathname;

describe.skipIf(skip)('installFocusGuards (fake facebook.com)', () => {
  let context: BrowserContext;
  let page: Page | null = null;
  beforeAll(async () => {
    context = await guardedFakeContext();
  });
  afterAll(async () => {
    await context.close();
  });

  async function openAt(path: string): Promise<Page> {
    if (page && !page.isClosed()) await page.close();
    page = await context.newPage();
    await page.goto(`https://www.facebook.com${path}`);
    const opened = page;
    await expect.poll(() => pathOf(opened)).toBe(path);
    await opened.locator('#path').waitFor();
    return opened;
  }

  it('leaves Marketplace pages alone and hides the global header', async () => {
    const page = await openAt('/marketplace/nyc/');
    await expect.poll(() => page.locator('div[role="banner"]').evaluate((el) => getComputedStyle(el).display)).toBe('none');
    const headerHeight = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--header-height').trim());
    expect(headerHeight).toBe('0px');
  });

  it("allows Facebook's login, 2FA and checkpoint pages (the login view lives here too)", async () => {
    for (const path of ['/login/', '/two_step_verification/two_factor/', '/checkpoint/1501092823525282/']) {
      const page = await openAt(path);
      await page.waitForTimeout(200);
      expect(pathOf(page)).toBe(path);
    }
  });

  it('redirects a full page load of a blocked page to Marketplace', async () => {
    const page = await openAt('/marketplace/nyc/');
    await page.goto('https://www.facebook.com/watch/?v=1').catch(() => undefined);
    await expect.poll(() => page.url()).toBe(FOCUS_HOME);
  });

  it('redirects location changes to blocked pages', async () => {
    const page = await openAt('/marketplace/nyc/');
    await page.evaluate(() => {
      location.assign('/groups/feed/');
    });
    await expect.poll(() => page.url()).toBe(FOCUS_HOME);
  });

  it('redirects history.pushState / replaceState to blocked paths', async () => {
    const first = await openAt('/marketplace/nyc/');
    await first.evaluate(() => {
      history.pushState({}, '', '/watch');
    });
    await expect.poll(() => first.url()).toBe(FOCUS_HOME);

    const second = await openAt('/marketplace/item/1/');
    await second.evaluate(() => {
      history.replaceState({}, '', '/reel/42/');
    });
    await expect.poll(() => second.url()).toBe(FOCUS_HOME);
  });

  it('allows in-app navigation within Marketplace', async () => {
    const page = await openAt('/marketplace/nyc/');
    await page.evaluate(() => {
      history.pushState({}, '', '/marketplace/item/9/');
    });
    expect(pathOf(page)).toBe('/marketplace/item/9/');
    await page.evaluate(() => {
      history.replaceState({}, '', '/messages/t/555/');
    });
    expect(pathOf(page)).toBe('/messages/t/555/');
  });

  it('blocks clicks on links that leave Marketplace, with a notice', async () => {
    const page = await openAt('/marketplace/nyc/');
    await page.evaluate(() => {
      const link = document.createElement('a');
      link.id = 'notifications';
      link.href = '/notifications';
      link.textContent = 'Notifications';
      document.body.prepend(link);
    });
    await page.click('#notifications');
    await page.click('#watch');
    await page.click('#shim');
    await page.waitForTimeout(500);
    expect(pathOf(page)).toBe('/marketplace/nyc/');
    await expect.poll(() => page.locator('#faceslop-focus-notice').textContent()).toContain('Only Marketplace');

    // javascript: links aren't navigation; allowed links still work.
    await page.click('#js');
    expect(pathOf(page)).toBe('/marketplace/nyc/');
    await page.click('#item');
    await expect.poll(() => pathOf(page)).toBe('/marketplace/item/123/');
  });

  it('blocks window.open to blocked pages', async () => {
    const page = await openAt('/marketplace/nyc/');
    expect(await page.evaluate(() => window.open('/watch') === null)).toBe(true);
    expect(context.pages()).toHaveLength(1);
  });

  it('does not police iframes', async () => {
    const page = await openAt('/marketplace/nyc/');
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.src = '/plugins/like.php';
      document.body.append(frame);
    });
    await expect.poll(() => page.frames().length).toBe(2);
    await page.waitForTimeout(300);
    expect(pathOf(page)).toBe('/marketplace/nyc/');
    expect(new URL(page.frames()[1]?.url() ?? '').pathname).toBe('/plugins/like.php');
  });
});

describe.skipIf(skip)('focus init script', () => {
  it('sends a page that landed somewhere blocked (e.g. via a server redirect) back to Marketplace', async () => {
    // Routes don't see redirect hops, so the init script re-checks the landing URL on its own.
    const context = await browser.newContext({ userAgent: USER_AGENT });
    try {
      await fakeFacebook(context);
      await context.addInitScript({ content: focusInitScript() });
      const page = await context.newPage();
      await page.goto('https://www.facebook.com/').catch(() => undefined);
      await expect.poll(() => page.url()).toBe(FOCUS_HOME);
    } finally {
      await context.close();
    }
  });
});

describe.skipIf(skip)('installFocusGuards (live, logged-out facebook.com)', () => {
  it('keeps the real Marketplace SPA on Marketplace', { timeout: 90_000 }, async (ctx) => {
    const context = await browser.newContext({ userAgent: USER_AGENT, locale: 'en-US', viewport: { width: 1280, height: 900 } });
    try {
      await installFocusGuards(context);
      const page = await context.newPage();
      try {
        await page.goto('https://www.facebook.com/marketplace/nyc/', { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.locator('div[role="banner"]').first().waitFor({ state: 'attached', timeout: 20_000 });
      } catch {
        ctx.skip(); // offline or Facebook unreachable
        return;
      }
      expect(pathOf(page)).toBe('/marketplace/nyc/');

      // Facebook's global header is hidden.
      const display = await page.locator('div[role="banner"]').first().evaluate((el) => getComputedStyle(el).display);
      expect(display).toBe('none');

      // A link to notifications does nothing.
      await page.evaluate(() => {
        const link = document.createElement('a');
        link.id = 'faceslop-test-link';
        link.href = '/notifications';
        link.textContent = 'notifications';
        link.style.cssText = 'position:fixed;top:100px;left:100px;z-index:2147483647;background:#fff;padding:8px';
        document.body.append(link);
      });
      await page.click('#faceslop-test-link', { force: true });
      await page.waitForTimeout(1000);
      expect(pathOf(page)).toMatch(/^\/marketplace/);

      // SPA navigation to /watch is turned back to Marketplace.
      await page.evaluate(() => {
        history.pushState({}, '', '/watch');
      });
      await expect.poll(() => page.url(), { timeout: 30_000 }).toBe(FOCUS_HOME);
      await page.waitForLoadState('domcontentloaded');
      expect(pathOf(page)).toBe('/marketplace/');
    } finally {
      await context.close();
    }
  });
});
