import { chromium } from 'playwright';

const origin = 'http://caddy:8080';
const mode = process.argv[2];
const browser = await chromium.launch();
const checkpoint = (stage) => process.stderr.write(`${mode}: ${stage}\n`);

async function collectorResponse(request) {
  if (!request) return null;
  let timeout;
  try {
    return await Promise.race([
      request.response(),
      new Promise((_, reject) => {
        timeout = globalThis.setTimeout(
          () =>
            reject(new Error('collector request did not finish within 30s')),
          30_000,
        );
      }),
    ]);
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function isolateDevelopmentClient(context) {
  // Neither script ships in production. Vite's HMR client can reload a page
  // while the full test suite is reading it, and the toolbar reads a preference.
  await context.route('**/@vite/client**', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: '' }),
  );
  await context.route('**/astro/runtime/client/dev-toolbar/**', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: '' }),
  );
}

try {
  if (mode === 'live') {
    checkpoint('browser launched');
    const context = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    await isolateDevelopmentClient(context);
    await context.addInitScript(() => {
      const touches = [];
      globalThis.__analyticsStorageTouches = touches;
      for (const key of ['localStorage', 'sessionStorage', 'indexedDB']) {
        Object.defineProperty(globalThis, key, {
          configurable: true,
          get() {
            touches.push(key);
            throw new Error(`${key} was accessed`);
          },
        });
      }
      Object.defineProperty(globalThis.document, 'cookie', {
        configurable: true,
        get() {
          touches.push('cookie-read');
          return '';
        },
        set() {
          touches.push('cookie-write');
        },
      });
    });
    const page = await context.newPage();
    const requestUrls = [];
    const collectorRequests = [];
    page.on('request', (request) => {
      requestUrls.push(request.url());
      if (request.url().endsWith('/analytics/api/send')) {
        collectorRequests.push(request);
      }
    });
    const pageResponse = await page.goto(
      `${origin}/privacy?ref=private-code&token=private-token#private-fragment`,
      {
        referer: 'https://partner.example/private?token=secret#fragment',
        waitUntil: 'load',
        timeout: 10_000,
      },
    );
    checkpoint('page loaded');
    const response = await collectorResponse(collectorRequests[0]);
    checkpoint('collector finished');
    const result = {
      pageStatus: pageResponse.status(),
      pageTitle: await page.title(),
      pageSetCookie: pageResponse.headers()['set-cookie'] ?? null,
      emitterScripts: await page.locator('script[src="/page-view.js"]').count(),
      requestUrls,
      collectorRequests: collectorRequests.map((request) =>
        request.postDataJSON(),
      ),
      collectorReferer: collectorRequests[0]?.headers().referer ?? null,
      collectorStatus: response?.status() ?? null,
      storageTouches: await page.evaluate(
        () => globalThis.__analyticsStorageTouches,
      ),
      cookies: await context.cookies(),
    };
    process.stdout.write(JSON.stringify(result));
    checkpoint('result written');
    await context.close();
    checkpoint('context closed');
  } else if (mode === 'excluded') {
    const context = await browser.newContext();
    await isolateDevelopmentClient(context);
    await context.route('https://challenges.cloudflare.com/**', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: '' }),
    );
    const result = [];
    for (const path of [
      '/me?token=private-token',
      '/verify?token=private-token',
      '/unsubscribe?token=private-token',
      '/api/admin/draw',
    ]) {
      checkpoint(`opening ${path}`);
      const page = await context.newPage();
      let collectorRequests = 0;
      page.on('request', (request) => {
        if (request.url().endsWith('/analytics/api/send'))
          collectorRequests += 1;
      });
      await page.goto(`${origin}${path}`, {
        waitUntil: 'load',
        timeout: 10_000,
      });
      result.push({
        path,
        emitterScripts: await page
          .locator('script[src="/page-view.js"]')
          .count(),
        collectorRequests,
      });
      await page.close();
      checkpoint(`closed ${path}`);
    }
    process.stdout.write(JSON.stringify(result));
    await context.close();
  } else if (mode === 'down') {
    const context = await browser.newContext();
    await isolateDevelopmentClient(context);
    const page = await context.newPage();
    const collectorRequests = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/analytics/api/send')) {
        collectorRequests.push(request);
      }
    });
    const pageResponse = await page.goto(`${origin}/privacy`, {
      waitUntil: 'load',
      timeout: 10_000,
    });
    const response = await collectorResponse(collectorRequests[0]);
    process.stdout.write(
      JSON.stringify({
        pageStatus: pageResponse.status(),
        pageTitle: await page.title(),
        collectorRequests: collectorRequests.length,
        collectorStatus: response?.status() ?? null,
      }),
    );
    await context.close();
  } else {
    throw new Error('Unknown page-view browser probe mode');
  }
} finally {
  checkpoint('closing browser');
  await browser.close();
  checkpoint('browser closed');
}
