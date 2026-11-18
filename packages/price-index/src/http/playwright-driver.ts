import { setTimeout as wait } from 'node:timers/promises';

import {
  chromium,
  errors,
  type Browser,
  type CDPSession,
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
    // The scrape command handles SIGINT and SIGTERM itself: it stops the run
    // cleanly as interrupted, then closes the browser (E11.6-07). Playwright's
    // own handlers would kill the browser under a page still loading.
    handleSIGINT: false,
    handleSIGTERM: false,
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

/** A paused request as the DevTools protocol reports it. */
interface PausedRequest {
  requestId: string;
  request: { url: string; headers: Record<string, string> };
  resourceType: string;
  frameId: string;
  redirectedRequestId?: string;
}

function pausedFacts(event: PausedRequest, mainFrameId: string): RequestFacts {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(event.request.headers)) {
    headers[name.toLowerCase()] = value;
  }
  return {
    url: event.request.url,
    // The protocol's names (`Document`, `XHR`, …) in Playwright's spelling.
    resourceType: event.resourceType.toLowerCase(),
    headers,
    isNavigation: event.resourceType === 'Document',
    isMainFrame: event.frameId === mainFrameId,
    isRedirect: event.redirectedRequestId !== undefined,
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
 * One browser context and one tab for the whole run, with the request rule on
 * every request they make, and one page at a time: a second `load` while one
 * is in progress throws.
 *
 * The tab is kept, not closed, between pages. Chromium lets some requests
 * outlive their page (a `<link rel=prefetch>`, a keep-alive fetch, a beacon);
 * if the tab closed while one waited for the rule, Chromium would send it on.
 * So after each page the tab moves to `about:blank`, where nothing more can
 * start and every request still waiting meets the rule, which refuses it. The
 * tab closes only once every routed request has been decided.
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
  let loading = false;
  const pendingRoutes = new Set<Promise<void>>();

  function track(decision: Promise<void>): Promise<void> {
    pendingRoutes.add(decision);
    void decision.finally(() => pendingRoutes.delete(decision));
    return decision;
  }

  // The rule is applied twice, and a request leaves only if both allow it.
  // Playwright's routing covers the whole context, but it lets a request
  // through unasked when it does not yet know the request's frame (an
  // iframe's first navigation) and for every later hop of a redirect. The
  // tab's own DevTools session (below) holds each of those, and every other
  // request of the tab, until the rule decides. Refusals are recorded once,
  // by that session.
  await context.route('**/*', (route, request) => {
    const decision = classifyRequest(
      requestFacts(request),
      current?.page ?? null,
    );
    return track(
      decision.allow
        ? route.continue().catch(() => undefined)
        : route.abort('blockedbyclient').catch(() => undefined),
    );
  });

  async function interceptTab(page: Page): Promise<CDPSession> {
    const session = await context.newCDPSession(page);
    const { frameTree } = await session.send('Page.getFrameTree');
    const mainFrameId = frameTree.frame.id;
    session.on('Fetch.requestPaused', (event: PausedRequest) => {
      const facts = pausedFacts(event, mainFrameId);
      const decision = classifyRequest(facts, current?.page ?? null);
      if (decision.allow) {
        void track(
          session
            .send('Fetch.continueRequest', { requestId: event.requestId })
            .then(
              () => undefined,
              () => undefined,
            ),
        );
        return;
      }
      current?.refused.push({
        url: facts.url,
        resourceType: facts.resourceType,
        reason: decision.reason,
      });
      void track(
        session
          .send('Fetch.failRequest', {
            requestId: event.requestId,
            errorReason: 'BlockedByClient',
          })
          .then(
            () => undefined,
            () => undefined,
          ),
      );
    });
    await session.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
    });
    return session;
  }

  const timeout = options.pageTimeoutMilliseconds;

  // The main-frame responses of the load in progress.
  let navigation: {
    latest: Response | null;
    onCleared: (() => void) | null;
  } | null = null;
  let tab: Page | null = null;
  let tabSession: CDPSession | null = null;

  async function openTab(): Promise<Page> {
    const opened = await context.newPage();
    opened.setDefaultTimeout(timeout);
    tabSession = await interceptTab(opened);
    const mainFrame = opened.mainFrame();
    opened.on('response', (response) => {
      if (
        navigation === null ||
        !response.request().isNavigationRequest() ||
        response.frame() !== mainFrame
      ) {
        return;
      }
      navigation.latest = response;
      if (!isRefusal(response)) {
        navigation.onCleared?.();
      }
    });
    return opened;
  }

  /** Every request already held for the rule is decided before this resolves. */
  async function drainRoutes(page: Page): Promise<void> {
    // A round trip on each channel: every request the browser held for the
    // rule before it has reached its handler by the time it returns.
    await within(page.evaluate('0'), timeout).catch(() => undefined);
    if (tabSession !== null) {
      await within(
        tabSession.send('Runtime.evaluate', { expression: '0' }),
        timeout,
      ).catch(() => undefined);
    }
    await Promise.allSettled([...pendingRoutes]);
  }

  /** Leaves the source's page; a tab that cannot is closed, once drained. */
  async function leavePage(page: Page): Promise<void> {
    try {
      await within(page.goto('about:blank'), timeout);
      await drainRoutes(page);
    } catch {
      await drainRoutes(page);
      tab = null;
      tabSession = null;
      await within(page.close(), timeout).catch(() => undefined);
    }
  }

  async function load(request: LoadRequest): Promise<LoadResult> {
    if (loading) {
      throw new Error(
        'A page is already loading; the fetcher opens one at a time.',
      );
    }
    loading = true;
    const refused: RefusedRequest[] = [];
    current = {
      page: {
        origin: options.origin,
        target: request.url,
        isPathOpenable: request.isPathOpenable,
      },
      refused,
    };
    const state: NonNullable<typeof navigation> = {
      latest: null,
      onCleared: null,
    };
    navigation = state;
    const checkpointTimer = new AbortController();
    let page: Page | null = null;
    try {
      tab ??= await openTab();
      page = tab;

      try {
        const first = await page.goto(request.url, {
          waitUntil: 'domcontentloaded',
          timeout,
        });
        state.latest ??= first;
      } catch (error) {
        return failure(error, refused);
      }
      const initial: Response | null = state.latest;
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
          const now: Response | null = state.latest;
          if (now !== null && now !== initial && !isRefusal(now)) {
            resolve('cleared');
          } else {
            state.onCleared = () => resolve('cleared');
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

      const final = state.latest as Response;
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
      // From here every request is refused, the page's own included.
      current = null;
      navigation = null;
      if (page !== null) {
        await leavePage(page);
      }
      loading = false;
    }
  }

  return {
    load,
    async close() {
      const page = tab;
      if (page !== null) {
        await drainRoutes(page);
      }
      tab = null;
      tabSession = null;
      await context.close();
    },
  };
}
