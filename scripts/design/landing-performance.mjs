// E11.5-12: the landing page's performance figures, measured in the local
// harness as the plan's item 3 defines them — at 390px, with the CPU slowed
// four times through the DevTools protocol: cumulative layout shift, largest
// contentful paint, the first-party JavaScript the page runs, and the bytes of
// every provider logo it loads. The same function measures any build, so the
// before-E11.5 figure is taken the same way as the current one.

export const performanceViewport = Object.freeze({ width: 390, height: 844 });
export const cpuThrottlingRate = 4;
export const largestContentfulPaintBudgetMilliseconds = 2_500;

// Collected from the first frame: every layout shift not caused by input and
// every largest-contentful-paint candidate, as the browser reports them.
function observePaints() {
  globalThis.__performanceAudit = { shifts: [], paints: [] };
  new globalThis.PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      if (!entry.hadRecentInput)
        globalThis.__performanceAudit.shifts.push(entry.value);
  }).observe({ type: 'layout-shift', buffered: true });
  new globalThis.PerformanceObserver((list) => {
    for (const entry of list.getEntries())
      globalThis.__performanceAudit.paints.push({
        startTime: entry.startTime,
        element: entry.element?.tagName ?? null,
        id: entry.element?.id || entry.element?.className || null,
      });
  }).observe({ type: 'largest-contentful-paint', buffered: true });
}

const frames = (page, count) =>
  page.evaluate(
    (total) =>
      new Promise((resolve) => {
        let left = total;
        const step = () =>
          (left -= 1) <= 0 ? resolve() : globalThis.requestAnimationFrame(step);
        globalThis.requestAnimationFrame(step);
      }),
    count,
  );

/**
 * Measures the landing page at `origin` in a fresh 390px context of
 * `browser` (Chromium), with the CPU throttled before the page is requested.
 * `prepareContext` may route requests (a Turnstile stand-in, say) first.
 */
export async function measureLandingPerformance(
  browser,
  origin,
  { prepareContext } = {},
) {
  const context = await browser.newContext({
    viewport: performanceViewport,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  });
  try {
    await prepareContext?.(context);
    await context.addInitScript(observePaints);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', {
      rate: cpuThrottlingRate,
    });
    const origins = new Set([new URL(origin).origin]);
    const scripts = [];
    const logos = [];
    const pending = [];
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (!origins.has(url.origin)) return;
      const type = response.request().resourceType();
      if (type === 'script')
        pending.push(
          response
            .body()
            .then((body) =>
              scripts.push({ path: url.pathname, bytes: body.length }),
            ),
        );
      else if (url.pathname.startsWith('/images/providers/'))
        pending.push(
          response
            .body()
            .then((body) =>
              logos.push({ path: url.pathname, bytes: body.length }),
            ),
        );
    });
    const response = await page.goto(new URL('/', origin).href, {
      waitUntil: 'load',
    });
    if (!response?.ok())
      throw new Error(`The landing page answered ${response?.status()}.`);
    // Let the first-paint entrance run its course and the paint entries
    // settle before reading them; LCP stops updating at the first input,
    // and nothing here is input.
    await page.waitForTimeout(3_000);
    await frames(page, 2);
    const atLoad = await page.evaluate(() => ({
      layoutShift: globalThis.__performanceAudit.shifts.reduce(
        (total, value) => total + value,
        0,
      ),
      paints: globalThis.__performanceAudit.paints,
    }));
    const inlineScriptBytes = await page.evaluate(() =>
      [...globalThis.document.querySelectorAll('script:not([src])')]
        .filter((script) =>
          ['', 'module', 'text/javascript'].includes(script.type),
        )
        .reduce(
          (total, script) =>
            total + new globalThis.TextEncoder().encode(script.text).length,
          0,
        ),
    );
    // Then through the whole page, sideways tracks included, so every lazy
    // logo loads; the shifts this scroll causes are counted apart.
    await page.evaluate(async () => {
      const frame = () =>
        new Promise((resolve) => globalThis.requestAnimationFrame(resolve));
      const { document } = globalThis;
      for (
        let top = 0;
        top < document.documentElement.scrollHeight;
        top += globalThis.innerHeight / 2
      ) {
        globalThis.scrollTo({ top, behavior: 'instant' });
        await frame();
        await frame();
      }
      for (const track of document.querySelectorAll('.provider-rail__track'))
        for (
          let left = 0;
          left < track.scrollWidth;
          left += track.clientWidth / 2
        ) {
          track.scrollIntoView({ behavior: 'instant', block: 'center' });
          track.scrollLeft = left;
          await frame();
          await frame();
        }
    });
    await page.waitForFunction(() =>
      [
        ...globalThis.document.querySelectorAll(
          'img[src*="/images/providers/"]',
        ),
      ]
        // A banner the layout hides at this width never loads its lazy logo.
        .filter((image) => image.checkVisibility())
        .every((image) => image.complete && image.naturalWidth > 0),
    );
    await page.waitForLoadState('networkidle');
    await Promise.all(pending);
    const scrolledLayoutShift = await page.evaluate(() =>
      globalThis.__performanceAudit.shifts.reduce(
        (total, value) => total + value,
        0,
      ),
    );
    const largest = atLoad.paints.at(-1) ?? null;
    const uniqueLogos = [
      ...new Map(logos.map((logo) => [logo.path, logo])).values(),
    ].sort((a, b) => a.path.localeCompare(b.path));
    const uniqueScripts = [
      ...new Map(scripts.map((script) => [script.path, script])).values(),
    ].sort((a, b) => a.path.localeCompare(b.path));
    return {
      cumulativeLayoutShift: atLoad.layoutShift,
      cumulativeLayoutShiftAfterScroll: scrolledLayoutShift,
      largestContentfulPaintMilliseconds: largest?.startTime ?? null,
      largestContentfulPaintElement: largest,
      firstPartyJavaScript: {
        inlineBytes: inlineScriptBytes,
        files: uniqueScripts,
        fileBytes: uniqueScripts.reduce((total, { bytes }) => total + bytes, 0),
        totalBytes:
          inlineScriptBytes +
          uniqueScripts.reduce((total, { bytes }) => total + bytes, 0),
      },
      logos: {
        count: uniqueLogos.length,
        totalBytes: uniqueLogos.reduce((total, { bytes }) => total + bytes, 0),
        files: uniqueLogos,
      },
    };
  } finally {
    await context.close();
  }
}
