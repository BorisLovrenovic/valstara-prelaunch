import { setTimeout as wait } from 'node:timers/promises';

import {
  chromium,
  errors,
  type Browser,
  type Page,
  type Request,
  type Response,
} from 'playwright';

import type {
  BrowserDriver,
  LoadRequest,
  LoadResult,
  RefusedRequest,
} from './driver.ts';
import {
  classifyRequest,
  type PageInProgress,
  type RequestFacts,
} from './request-rule.ts';

// The real browser driver (E11.6-04). Pages load in headless Chromium,
// driven by Playwright, presenting as an ordinary browser (founder decision
// 2 of 2026-11-17). The measures are the three the founder's capture used
// and nothing more (docs/features/price-index-source-findings.md#conditional-
// requests-and-the-bot-checkpoint):
//   - the launch argument below, so Blink does not flag automation;
//   - `HeadlessChrome` replaced with `Chrome` in the User-Agent;
//   - `navigator.webdriver` hidden.
// No challenge widget is ever answered, and every request leaves from the
// founder's own connection (the evasion scan enforces both).

export const evasionLaunchArguments = [
  '--disable-blink-features=AutomationControlled',
] as const;

/**
 * Makes every host but the source's unresolvable inside the browser.
 * Playwright's routing never sees the later hops of a redirect, so without
 * this a source page redirecting elsewhere would reach that host; with it,
 * such a hop fails before a connection is made.
 */
export function sourceOnlyLaunchArguments(origin: string): string[] {
  return [
    `--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE ${new URL(origin).hostname}`,
  ];
}

const locale = 'en-US';
const viewport = { width: 1366, height: 900 };
const checkpointTitle = /vercel security checkpoint/iu;

/** Launches the run's browser. The founder's run only; tests connect to one. */
export function launchChromium(origin: string): Promise<Browser> {
  return chromium.launch({
    headless: true,
    args: [...evasionLaunchArguments, ...sourceOnlyLaunchArguments(origin)],
  });
}

/** The browser's own User-Agent, minus the headless marker. */
async function ordinaryUserAgent(browser: Browser): Promise<string> {
  const probe = await browser.newContext();
  try {
    const page = await probe.newPage();
    const userAgent: string = await page.evaluate('navigator.userAgent');
    return userAgent.replace('HeadlessChrome', 'Chrome');
  } finally {
    await probe.close();
  }
}

// Given as source text: a compiled function can carry helper calls that do
// not exist in the page, and would then throw there.
const hideWebdriver = `Object.defineProperty(Navigator.prototype, 'webdriver', {
  get: () => undefined,
  configurable: true,
});`;

function requestFacts(request: Request): RequestFacts {
  let isMainFrame = false;
  try {
    isMainFrame = request.frame().parentFrame() === null;
  } catch {
    // A request with no frame (a worker's) is never the main frame.
  }
  return {
    url: request.url(),
    resourceType: request.resourceType(),
    headers: request.headers(),
    isNavigation: request.isNavigationRequest(),
    isMainFrame,
    isRedirect: request.redirectedFrom() !== null,
  };
}

function isRefusal(response: Response): boolean {
  const status = response.status();
  return (
    status === 403 ||
    status === 429 ||
    response.headers()['x-vercel-mitigated'] === 'challenge'
  );
}

async function pageTitle(page: Page, timeout: number): Promise<string> {
  try {
    return await page.title();
  } catch {
    // A navigation was in progress; read the new document once it is there.
    try {
      await page.waitForLoadState('domcontentloaded', { timeout });
      return await page.title();
    } catch {
      return '';
    }
  }
}

/** Bounds a step with no timeout of its own, such as reading the page. */
async function within<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  const timer = new AbortController();
  try {
    return await Promise.race([
      promise,
      wait(milliseconds, undefined, { signal: timer.signal }).then(() => {
        throw new errors.TimeoutError(`timed out after ${milliseconds} ms`);
      }),
    ]);
  } finally {
    timer.abort();
  }
}

function failure(error: unknown, refused: RefusedRequest[]): LoadResult {
  const message = error instanceof Error ? error.message.split('\n')[0] : '';
  return {
    kind: error instanceof errors.TimeoutError ? 'timeout' : 'error',
    message: message ?? 'unknown error',
    refused,
  };
}

export interface PlaywrightDriverOptions {
  browser: Browser;
  /** The source's origin; every other host is refused. */
  origin: string;
  pageTimeoutMilliseconds: number;
  checkpointWaitMilliseconds: number;
}

/**
 * One browser context for the whole run, with the request rule on every
 * request it makes, and one page at a time: a second `load` while one is in
 * progress throws.
 */
export async function createPlaywrightDriver(
  options: PlaywrightDriverOptions,
): Promise<BrowserDriver> {
  const userAgent = await ordinaryUserAgent(options.browser);
  const context = await options.browser.newContext({
    userAgent,
    locale,
    viewport,
    // A service worker's requests would bypass the rule below.
    serviceWorkers: 'block',
  });
  await context.addInitScript({ content: hideWebdriver });

  let current: { page: PageInProgress; refused: RefusedRequest[] } | null =
    null;

  await context.route('**/*', async (route, request) => {
    const decision = classifyRequest(
      requestFacts(request),
      current?.page ?? null,
    );
    if (decision.allow) {
      await route.continue().catch(() => undefined);
      return;
    }
    current?.refused.push({
      url: request.url(),
      resourceType: request.resourceType(),
      reason: decision.reason,
    });
    await route.abort('blockedbyclient').catch(() => undefined);
  });

  const timeout = options.pageTimeoutMilliseconds;

  async function load(request: LoadRequest): Promise<LoadResult> {
    if (current !== null) {
      throw new Error(
        'A page is already loading; the fetcher opens one at a time.',
      );
    }
    const refused: RefusedRequest[] = [];
    current = {
      page: {
        origin: options.origin,
        target: request.url,
        isPathOpenable: request.isPathOpenable,
      },
      refused,
    };
    let page: Page | null = null;
    const checkpointTimer = new AbortController();
    try {
      page = await context.newPage();
      page.setDefaultTimeout(timeout);
      const mainFrame = page.mainFrame();

      let latest: Response | null = null;
      let onCleared: (() => void) | null = null;
      page.on('response', (response) => {
        if (
          !response.request().isNavigationRequest() ||
          response.frame() !== mainFrame
        ) {
          return;
        }
        latest = response;
        if (!isRefusal(response)) {
          onCleared?.();
        }
      });

      try {
        const first = await page.goto(request.url, {
          waitUntil: 'domcontentloaded',
          timeout,
        });
        latest ??= first;
      } catch (error) {
        return failure(error, refused);
      }
      const initial: Response | null = latest;
      if (initial === null) {
        return { kind: 'error', message: 'no response', refused };
      }

      // The checkpoint answers 403 or 429, or is marked or titled as one. It
      // gets its configured time to complete (it reloads the page itself);
      // nothing here retries it.
      if (
        isRefusal(initial) ||
        checkpointTitle.test(await pageTitle(page, timeout))
      ) {
        const cleared = new Promise<'cleared'>((resolve) => {
          const now: Response | null = latest;
          if (now !== null && now !== initial && !isRefusal(now)) {
            resolve('cleared');
          } else {
            onCleared = () => resolve('cleared');
          }
        });
        const outcome = await Promise.race([
          cleared,
          wait(options.checkpointWaitMilliseconds, 'waited' as const, {
            signal: checkpointTimer.signal,
          }),
        ]);
        if (outcome === 'cleared') {
          await page
            .waitForLoadState('domcontentloaded', { timeout })
            .catch(() => undefined);
        }
      }

      const final = latest as Response;
      const checkpoint =
        final.headers()['x-vercel-mitigated'] === 'challenge' ||
        checkpointTitle.test(await pageTitle(page, timeout));
      const finalUrl = page.url();
      if (new URL(finalUrl).origin !== options.origin) {
        return {
          kind: 'error',
          message: `the page left the source for ${new URL(finalUrl).host}`,
          refused,
        };
      }
      let content: string;
      try {
        content =
          request.read === 'body'
            ? await within(final.text(), timeout)
            : await within(page.content(), timeout);
      } catch (error) {
        return failure(error, refused);
      }
      return {
        kind: 'loaded',
        status: final.status(),
        finalUrl,
        checkpoint,
        retryAfter: final.headers()['retry-after'] ?? null,
        content,
        refused,
      };
    } finally {
      checkpointTimer.abort();
      if (page !== null) {
        await within(page.close(), timeout).catch(() => undefined);
      }
      current = null;
    }
  }

  return {
    load,
    close: () => context.close(),
  };
}
