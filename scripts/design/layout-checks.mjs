/* global document, window, getComputedStyle */
export const designWidths = Object.freeze([
  320, 360, 390, 768, 1024, 1280, 1440, 1920,
]);
export const designThemes = Object.freeze(['light', 'dark']);

// Pages enter this list in the ticket that redesigns them. E11.5-12 compares
// it to the complete rendered-page inventory.
export const enforcedPages = Object.freeze([]);

export async function checkPageLayout(page) {
  return page.evaluate(() => {
    const issues = [];
    const viewportWidth = document.documentElement.clientWidth;
    if (document.documentElement.scrollWidth > viewportWidth + 1) {
      issues.push('horizontal overflow');
    }

    const visible = (element) => {
      const style = getComputedStyle(element);
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        element.getClientRects().length > 0
      );
    };
    for (const element of document.querySelectorAll('body *')) {
      if (!visible(element)) continue;
      const style = getComputedStyle(element);
      if (
        element.textContent?.trim() &&
        (['hidden', 'clip'].includes(style.overflowX) ||
          ['hidden', 'clip'].includes(style.overflowY)) &&
        (element.scrollWidth > element.clientWidth + 1 ||
          element.scrollHeight > element.clientHeight + 1)
      ) {
        issues.push(`clipped text: ${element.tagName.toLowerCase()}`);
      }
    }

    if (viewportWidth < 640) {
      for (const element of document.querySelectorAll(
        'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"]',
      )) {
        if (!visible(element) || element.disabled) continue;
        const rect = element.getBoundingClientRect();
        if (rect.width < 44 || rect.height < 44) {
          issues.push(
            `small target: ${element.tagName.toLowerCase()} ${Math.round(rect.width)}x${Math.round(rect.height)}`,
          );
        }
      }
    }

    for (const [imageIndex, image] of [...document.images].entries()) {
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

    const containers = [
      ...document.querySelectorAll('[data-design-container]'),
    ];
    if (containers.length === 0) issues.push('missing design container');
    for (const element of document.querySelectorAll('[data-grid-align]')) {
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

    const focusables = [
      ...document.querySelectorAll(
        'a[href],button,input:not([type="hidden"]),select,textarea,summary,[tabindex]:not([tabindex="-1"])',
      ),
    ].filter((element) => visible(element) && !element.disabled);
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
  });
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
