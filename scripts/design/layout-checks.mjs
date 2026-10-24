/* global document, window, getComputedStyle */
export const designWidths = Object.freeze([
  320, 360, 390, 768, 1024, 1280, 1440, 1920,
]);
export const designThemes = Object.freeze(['light', 'dark']);

// Pages enter this list in the ticket that redesigns them. E11.5-12 compares
// it to the complete rendered-page inventory.
export const enforcedPages = Object.freeze([
  '/verify',
  '/me',
  '/leaderboard',
  // E11.5-09: the trust, legal and giveaway-rules pages, including every
  // published rules revision at its permanent URL.
  '/legit',
  '/guarantee',
  '/about',
  '/terms',
  '/privacy',
  '/privacy/storage',
  '/giveaway/rules',
  '/giveaway/rules/VAL-GW-LAUNCH-20260925-r1',
  '/giveaway/rules/VAL-GW-LAUNCH-20261001-r1',
  '/giveaway/rules/VAL-GW-LAUNCH-20261009-r1',
]);

// The site shell: BaseLayout's header and footer landmarks. E11.5-03 enforces
// the layout rules on these regions on every rendered page, while page bodies
// join `enforcedPages` in the ticket that redesigns them.
export const shellRegions = Object.freeze(['body > header', 'body > footer']);

export async function checkPageLayout(page) {
  return checkLayout(page, null);
}

export async function checkShellLayout(page) {
  return checkLayout(page, shellRegions);
}

async function checkLayout(page, regions) {
  return page.evaluate((scopes) => {
    const issues = [];
    const viewportWidth = document.documentElement.clientWidth;
    const roots =
      scopes === null
        ? [document.body]
        : scopes.flatMap((scope) => {
            const found = [...document.querySelectorAll(scope)];
            if (found.length === 0) issues.push(`missing region: ${scope}`);
            return found;
          });
    const within = (selector) =>
      roots.flatMap((root) => [...root.querySelectorAll(selector)]);
    if (scopes === null) {
      if (document.documentElement.scrollWidth > viewportWidth + 1) {
        issues.push('horizontal overflow');
      }
    } else {
      for (const root of roots) {
        const box = root.getBoundingClientRect();
        if (
          root.scrollWidth > root.clientWidth + 1 ||
          box.left < -1 ||
          box.right > viewportWidth + 1
        ) {
          issues.push(`horizontal overflow: ${root.tagName.toLowerCase()}`);
        }
      }
    }

    const visible = (element) => {
      const style = getComputedStyle(element);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        element.getClientRects().length > 0
      );
    };
    for (const element of within('*')) {
      if (!visible(element)) continue;
      const style = getComputedStyle(element);
      if (
        element.textContent?.trim() &&
        ((['hidden', 'clip', 'visible'].includes(style.overflowX) &&
          element.scrollWidth > element.clientWidth + 1) ||
          (['hidden', 'clip', 'visible'].includes(style.overflowY) &&
            element.scrollHeight > element.clientHeight + 1))
      ) {
        const clipped =
          ['hidden', 'clip'].includes(style.overflowX) ||
          ['hidden', 'clip'].includes(style.overflowY);
        issues.push(
          `${clipped ? 'clipped' : 'overflowing'} text: ${element.tagName.toLowerCase()}`,
        );
      }
    }

    if (viewportWidth < 640) {
      for (const element of within(
        'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"]',
      )) {
        if (!visible(element) || element.disabled) continue;
        // The skip link is intentionally translated off screen until focused.
        if (element.matches('.skip-link:not(:focus-visible)')) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width < 44 || rect.height < 44) {
          issues.push(
            `small target: ${element.tagName.toLowerCase()} ${Math.round(rect.width)}x${Math.round(rect.height)}`,
          );
        }
      }
    }

    for (const [imageIndex, image] of within('img').entries()) {
      const intrinsicWidth = Number(image.getAttribute('width'));
      const intrinsicHeight = Number(image.getAttribute('height'));
      if (
        !image.hasAttribute('width') ||
        !image.hasAttribute('height') ||
        !Number.isFinite(intrinsicWidth) ||
        !Number.isFinite(intrinsicHeight) ||
        intrinsicWidth <= 0 ||
        intrinsicHeight <= 0
      ) {
        issues.push(`image without intrinsic dimensions #${imageIndex + 1}`);
      }
    }

    if (scopes === null) {
      if (within('[data-design-container]').length === 0)
        issues.push('missing design container');
    } else {
      for (const root of roots) {
        if (root.querySelector('[data-design-container]') === null)
          issues.push(
            `missing design container: ${root.tagName.toLowerCase()}`,
          );
      }
    }
    for (const element of within('[data-grid-align]')) {
      const container = element.closest('[data-design-container]');
      if (!container) {
        issues.push('grid item outside container');
        continue;
      }
      const item = element.getBoundingClientRect();
      const grid = container.getBoundingClientRect();
      const edge = element.getAttribute('data-grid-align');
      if (
        (edge === 'start' && Math.abs(item.left - grid.left) > 1) ||
        (edge === 'end' && Math.abs(item.right - grid.right) > 1)
      ) {
        issues.push(`grid misalignment: ${edge}`);
      }
    }

    const focusables = within(
      'a[href],button,input:not([type="hidden"]),select,textarea,summary,[tabindex]:not([tabindex="-1"])',
    ).filter((element) => visible(element) && !element.disabled);
    for (const element of focusables) {
      element.focus({ preventScroll: true });
      element.scrollIntoView({ block: 'end', inline: 'nearest' });
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const x = Math.min(
        viewportWidth - 1,
        Math.max(0, rect.left + rect.width / 2),
      );
      const y = Math.min(
        window.innerHeight - 1,
        Math.max(0, rect.top + rect.height / 2),
      );
      const top = document.elementFromPoint(x, y);
      if (!top || element === top || element.contains(top)) continue;
      let overlay = top;
      while (overlay && overlay !== document.body) {
        const position = getComputedStyle(overlay).position;
        if (position === 'fixed' || position === 'sticky') {
          issues.push(`focus obscured: ${element.tagName.toLowerCase()}`);
          break;
        }
        overlay = overlay.parentElement;
      }
    }
    return [...new Set(issues)];
  }, regions);
}

export async function assertEnforcedPages(browser, origin) {
  for (const route of enforcedPages) {
    for (const width of designWidths) {
      for (const theme of designThemes) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          colorScheme: theme,
        });
        try {
          const page = await context.newPage();
          await page.goto(new URL(route, origin).href);
          const issues = await checkPageLayout(page);
          if (issues.length)
            throw new Error(
              `${route} ${width}px ${theme}: ${issues.join(', ')}`,
            );
        } finally {
          await context.close();
        }
      }
    }
  }
}

export async function assertShellLayout(browser, origin, routes) {
  for (const route of routes) {
    for (const width of designWidths) {
      for (const theme of designThemes) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          colorScheme: theme,
        });
        try {
          const page = await context.newPage();
          await page.goto(new URL(route, origin).href);
          const issues = await checkShellLayout(page);
          if (issues.length)
            throw new Error(
              `shell on ${route} ${width}px ${theme}: ${issues.join(', ')}`,
            );
        } finally {
          await context.close();
        }
      }
    }
  }
}
