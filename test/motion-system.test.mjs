import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import { chromium } from 'playwright';
import { designWidths } from '../scripts/design/layout-checks.mjs';
import { ensureAppBuild } from '../scripts/ci/app-build.mjs';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';
import { focusMotionIssues } from './helpers/motion.mjs';

// E11.5-11i: the motion system of design rule 12, proven on a fixture page
// built from the shipping tokens.css and motion.css (no production page
// applies data-reveal or data-enter until the ticket that redesigns it), and
// its site-wide parts (page transitions, smooth scrolling, the theme
// cross-fade) gated on the built app.

const execFileAsync = promisify(execFile);
const browserContainer = `valstara-motion-playwright-${process.pid}`;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const viewportHeight = 900;
const tolerance = 1;

const [tokensCss, motionCss] = await Promise.all([
  readFile(new URL('../src/styles/tokens.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/styles/motion.css', import.meta.url), 'utf8'),
]);

// A page shaped like the landing page's sections: a first-paint entrance
// above the fold (index 6 is past the cap), then revealed content below it,
// a row indexed in reading order, a tall card and a focusable link, and a
// footer that does not reveal. The fixture's own layout values are test
// scaffolding; every motion value comes from the shipping files.
function fixturePage(motion = motionCss, { rowCards = 3 } = {}) {
  const card = (index) =>
    `<li data-reveal style="--reveal-index: ${index}"><h3>Card ${index + 1}</h3><p>Fixture text for a card in a revealed row, long enough to wrap at small widths.</p></li>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Motion fixture</title><style>${tokensCss}
${motion}
body { margin: 0; font-family: var(--font-sans); background: var(--paper); color: var(--ink); }
main { max-width: var(--container-max); margin: 0 auto; padding: 0 var(--gutter); }
.hero { min-height: 100vh; padding-block: var(--space-4); }
.row { list-style: none; padding: 0; display: grid; gap: var(--space-2); }
@media (min-width: 48rem) { .row { grid-template-columns: repeat(3, 1fr); } }
.row li, .card { padding: var(--space-3); background: var(--surface); border-radius: var(--radius-card); }
.tall { min-height: 20rem; }
section { margin-block: var(--section-gap); }
footer { min-height: 60vh; padding: var(--space-4) var(--gutter); background: var(--midnight); color: var(--on-midnight); }
</style></head><body><main>
<div class="hero">
<h1 data-enter="shift">Fixture heading</h1>
<p data-enter style="--enter-index: 1">A supporting line that fades in as it rises.</p>
<p data-enter style="--enter-index: 2">A second line, one stagger step later.</p>
<form data-enter="shift" style="--enter-index: 3"><label for="email">Email</label> <input id="email" type="email"> <button type="button">Join</button></form>
<p data-enter style="--enter-index: 6">An index past the cap starts with index 3.</p>
</div>
<section class="card" data-reveal><h2>A revealed section</h2><p>Below the fold, this rises and fades in as it enters the viewport.</p></section>
<ul class="row">${[...Array(rowCards).keys()].map(card).join('')}</ul>
<section class="card tall" data-reveal><h2>A tall card</h2><p>Taller than the others at every width.</p></section>
<section class="card" data-reveal><h2>A card with a link</h2><p><a id="revealed-link" href="#revealed-link">A link inside revealed content</a></p></section>
</main><footer><p>A footer that does not reveal.</p></footer></body></html>`;
}

let browser;
let browserServer;
let app;
let browserOrigin;

before(async () => {
  await ensureAppBuild();
  app = await startAppServer({
    label: 'Motion system test',
    env: () => ({
      ADMIN_CREDENTIAL: 'motion-system-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL: 'postgresql://unused:unused@127.0.0.1:5434/unused-motion',
      HOST: '0.0.0.0',
      IP_PREFIX_PEPPER: 'motion-system-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'motion-system-referral-secret',
      RESEND_API_KEY: 'motion-system-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: 'motion-system-turnstile-secret',
    }),
  });
  browserOrigin = `http://host.docker.internal:${app.port}`;
  const projectRoot = fileURLToPath(new URL('..', import.meta.url));
  browserServer = spawn(
    'docker',
    [
      'run',
      '--rm',
      '--name',
      browserContainer,
      '--add-host',
      'host.docker.internal:host-gateway',
      '--publish',
      '127.0.0.1::3000',
      '--volume',
      `${projectRoot}:/work:ro`,
      '--workdir',
      '/work',
      playwrightImage,
      '/work/node_modules/.bin/playwright',
      'run-server',
      '--host',
      '0.0.0.0',
      '--port',
      '3000',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  browserServer.stdout.on('data', (chunk) => {
    output += chunk;
  });
  browserServer.stderr.on('data', (chunk) => {
    output += chunk;
  });
  for (
    let attempt = 0;
    attempt < 720 && !output.includes('Listening on');
    attempt += 1
  ) {
    if (browserServer.exitCode !== null)
      throw new Error(`Playwright server exited: ${output}`);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  }
  assert.match(output, /Listening on/u);
  browser = await chromium.connect(
    `ws://127.0.0.1:${await publishedPort(browserContainer, 3000)}/`,
  );
});

after(async () => {
  await browser?.close();
  await execFileAsync('docker', ['rm', '--force', browserContainer]).catch(
    () => {},
  );
  if (browserServer !== undefined && browserServer.exitCode === null) {
    const exited = once(browserServer, 'exit');
    browserServer.kill('SIGTERM');
    await exited;
  }
  await app?.stop();
});

async function openFixture({
  width = 390,
  reducedMotion = 'no-preference',
  html = fixturePage(),
} = {}) {
  const context = await browser.newContext({
    viewport: { width, height: viewportHeight },
    reducedMotion,
  });
  const page = await context.newPage();
  await page.setContent(html, { waitUntil: 'load' });
  // A reveal's view timeline resolves only in a rendering update, and `load`
  // can fire before the first one. Until then every reveal reads at rest, so
  // wait for two frames before any test reads the fixture.
  await frames(page);
  return { context, page };
}

// In the page: the motion state of every data-reveal and data-enter element.
// At rest means opacity 1 and no transform of any kind.
function motionStates(page) {
  return page.evaluate(() => {
    const { document, getComputedStyle } = globalThis;
    return [...document.querySelectorAll('[data-reveal], [data-enter]')].map(
      (element, index) => {
        const style = getComputedStyle(element);
        const rest =
          style.opacity === '1' &&
          style.transform === 'none' &&
          style.translate === 'none' &&
          style.scale === 'none' &&
          style.rotate === 'none';
        return {
          index,
          kind: element.hasAttribute('data-reveal') ? 'reveal' : 'enter',
          name: element.textContent.trim().slice(0, 24),
          rest,
          opacity: Number(style.opacity),
          animations: element.getAnimations().length,
        };
      },
    );
  });
}

function finishEntrances(page) {
  return page.evaluate(() =>
    Promise.all(
      globalThis.document
        .getAnimations()
        .filter(
          (animation) => animation.timeline === globalThis.document.timeline,
        )
        .map((animation) => animation.finished),
    ),
  );
}

function frames(page) {
  return page.evaluate(
    () =>
      new Promise((resolve) =>
        globalThis.requestAnimationFrame(() =>
          globalThis.requestAnimationFrame(resolve),
        ),
      ),
  );
}

// Instant, so smooth scrolling never leaves a measurement mid-scroll.
async function scrollToY(page, y) {
  await page.evaluate(
    (top) => globalThis.scrollTo({ top, behavior: 'instant' }),
    y,
  );
  await frames(page);
}

// The document tops of the revealed elements at rest, read with the
// animations held off, so the measured position is the layout position.
async function restingTops(page) {
  const tops = await page.evaluate(() => {
    const { document } = globalThis;
    const hold = document.createElement('style');
    hold.textContent = '[data-reveal] { animation: none !important; }';
    document.head.append(hold);
    const tops = [...document.querySelectorAll('[data-reveal]')].map(
      (element) => element.getBoundingClientRect().top + globalThis.scrollY,
    );
    hold.remove();
    return tops;
  });
  // The re-attached reveals resolve their scroll timelines on the next frame.
  await frames(page);
  return tops;
}

test('no support means no hiding: with animations disabled every reveal and entrance element is at rest', async () => {
  for (const width of [320, 1440]) {
    const { context, page } = await openFixture({ width });
    try {
      // The fixture's motion is live: before the injected style, the
      // below-the-fold reveals are hidden by their running animation.
      assert.ok(
        (await motionStates(page)).some(
          (state) => state.kind === 'reveal' && !state.rest,
        ),
        `${width}px: reveals are running before animations are disabled`,
      );
      await page.addStyleTag({
        content: '*, *::before, *::after { animation: none !important; }',
      });
      for (const y of [0, viewportHeight, 100_000]) {
        await scrollToY(page, y);
        const restless = (await motionStates(page)).filter(
          (state) => !state.rest || state.animations > 0,
        );
        assert.deepEqual(restless, [], `${width}px at ${y}`);
      }
    } finally {
      await context.close();
    }
  }
});

test('without scroll-driven animation support the reveals stay at rest, and the entrance still runs', async () => {
  const unsupported = motionCss.replace(
    '@supports (animation-timeline: view())',
    '@supports (animation-timeline: not-a-supported-value)',
  );
  assert.notEqual(unsupported, motionCss, 'the @supports guard was found');
  const { context, page } = await openFixture({
    html: fixturePage(unsupported),
  });
  try {
    const states = await motionStates(page);
    assert.deepEqual(
      states.filter((state) => state.kind === 'reveal' && !state.rest),
      [],
      'no reveal is hidden',
    );
    assert.equal(
      states.filter((state) => state.kind === 'reveal' && state.animations)
        .length,
      0,
    );
    assert.ok(
      states.some((state) => state.kind === 'enter' && state.animations > 0),
      'the time-based entrance does not depend on scroll-driven support',
    );
  } finally {
    await context.close();
  }
});

test('with reduced motion requested the fixture renders at rest and nothing animates', async () => {
  const { context, page } = await openFixture({ reducedMotion: 'reduce' });
  try {
    for (const y of [0, viewportHeight]) {
      await scrollToY(page, y);
      assert.deepEqual(
        (await motionStates(page)).filter((state) => !state.rest),
        [],
      );
    }
    assert.deepEqual(
      await page.evaluate(() => ({
        animations: globalThis.document.getAnimations().length,
        scroll: globalThis.getComputedStyle(globalThis.document.documentElement)
          .scrollBehavior,
      })),
      { animations: 0, scroll: 'auto' },
    );
  } finally {
    await context.close();
  }
});

test('every revealed element is at rest by 70% of the viewport height and at the page end, at every test width', async () => {
  for (const width of designWidths) {
    const { context, page } = await openFixture({ width });
    try {
      await finishEntrances(page);
      const tops = await restingTops(page);
      assert.equal(tops.length, 6, 'six revealed elements');
      // Below the fold at load, every one is waiting on its reveal, so the
      // at-rest assertions below are not vacuous.
      const hidden = (await motionStates(page)).filter(
        (state) => state.kind === 'reveal',
      );
      assert.deepEqual(
        hidden.filter((state) => state.rest || state.animations !== 1),
        [],

        `${width}px: every reveal is running below the fold`,
      );
      for (const [index, top] of tops.entries()) {
        await scrollToY(page, top - 0.7 * viewportHeight);
        const state = (await motionStates(page)).filter(
          (entry) => entry.kind === 'reveal',
        )[index];
        assert.ok(
          state.rest,
          `${width}px: reveal ${index + 1} (${state.name}) is at rest with its top at 70% (opacity ${state.opacity})`,
        );
      }
      await scrollToY(page, 100_000);
      assert.deepEqual(
        (await motionStates(page)).filter((state) => !state.rest),
        [],
        `${width}px: at the page end`,
      );
    } finally {
      await context.close();
    }
  }
});

test('a long row stays in the range: past the last index every card moves with it and is at rest by 70%', async () => {
  for (const width of designWidths) {
    const { context, page } = await openFixture({
      width,
      html: fixturePage(motionCss, { rowCards: 10 }),
    });
    try {
      await finishEntrances(page);
      const tops = await restingTops(page);
      assert.equal(tops.length, 13, 'thirteen revealed elements');
      const reveals = async () =>
        (await motionStates(page)).filter((state) => state.kind === 'reveal');
      const heights = await page.evaluate(() =>
        [...globalThis.document.querySelectorAll('[data-reveal]')].map(
          (element) => element.getBoundingClientRect().height,
        ),
      );
      // The row is reveals 1 to 10; cards 5 to 10 carry indices 4 to 9.
      for (const index of [5, 6, 8, 10]) {
        // 90% of the way through the range, which ends about at the smaller of
        // the card's height and 20% of the viewport: inside the last index's
        // stretch. A card whose start has passed the end is still fully
        // hidden here and jumps to rest later.
        await scrollToY(
          page,
          tops[index] -
            viewportHeight +
            0.9 * Math.min(heights[index], 0.2 * viewportHeight),
        );
        const { opacity } = (await reveals())[index];
        assert.ok(
          opacity > 0 && opacity < 1,
          `${width}px: card ${index} is partway through its reveal (opacity ${opacity})`,
        );
      }
      for (const [index, top] of tops.entries()) {
        await scrollToY(page, top - 0.7 * viewportHeight);
        const state = (await reveals())[index];
        assert.ok(
          state.rest,
          `${width}px: reveal ${index + 1} (${state.name}) is at rest with its top at 70% (opacity ${state.opacity})`,
        );
      }
    } finally {
      await context.close();
    }
  }
});

// A short element with nothing after it: the scroll ends before it has
// covered its reveal range, at any width. Fixture values are scaffolding.
function endOfPageFixture(reveals, { lead = '100vh' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>End of page</title><style>${tokensCss}
${motionCss}
html, body, p { margin: 0; }
.lead { min-height: ${lead}; }
[data-reveal] { block-size: 20px; }
</style></head><body><div class="lead"></div>${reveals}</body></html>`;
}

test('a short reveal at the very end of a page reaches rest', async () => {
  for (const [label, reveals] of [
    ['one short element', '<p data-reveal>Last line</p>'],
    [
      'an indexed row',
      [0, 1, 4]
        .map(
          (index) =>
            `<p data-reveal style="--reveal-index: ${index}">Line ${index}</p>`,
        )
        .join(''),
    ],
  ]) {
    for (const width of designWidths) {
      const { context, page } = await openFixture({
        width,
        html: endOfPageFixture(reveals),
      });
      try {
        // Not vacuous: above the end, the element is still mid-reveal.
        await scrollToY(page, 10);
        const [waiting] = await motionStates(page);
        assert.equal(waiting.rest, false, `${label} ${width}px: still waiting`);
        await scrollToY(page, 100_000);
        assert.deepEqual(
          (await motionStates(page)).filter((state) => !state.rest),
          [],
          `${label} at ${width}px, at the page end`,
        );
      } finally {
        await context.close();
      }
    }
  }
});

test('a reveal on a page too short to scroll is at rest', async () => {
  for (const lead of ['calc(100vh - 60px)', 'calc(100vh - 20px)']) {
    const { context, page } = await openFixture({
      html: endOfPageFixture('<p data-reveal>Last line</p>', { lead }),
    });
    try {
      await frames(page);
      assert.equal(
        await page.evaluate(
          () =>
            globalThis.document.documentElement.scrollHeight -
            globalThis.innerHeight,
        ),
        0,
        `${lead}: the page does not scroll`,
      );
      assert.deepEqual(
        (await motionStates(page)).filter((state) => !state.rest),
        [],
        lead,
      );
    } finally {
      await context.close();
    }
  }
});

test('a row reveals in reading order: each index starts later and all come to rest together', async () => {
  const { context, page } = await openFixture({ width: 1440 });
  try {
    await finishEntrances(page);
    const [, rowTop] = await restingTops(page);
    // The row's top at 92% of the viewport: early in the range, where a
    // later index is further from rest than an earlier one.
    await scrollToY(page, rowTop - 0.92 * viewportHeight);
    const row = (await motionStates(page)).filter(
      (state) => state.kind === 'reveal',
    );
    const [first, second, third] = row
      .slice(1, 4)
      .map((state) => state.opacity);
    assert.ok(
      first > second && second > third,
      `reading order: ${first} > ${second} > ${third}`,
    );
    await scrollToY(page, rowTop - 0.7 * viewportHeight);
    assert.deepEqual(
      (await motionStates(page))
        .filter((state) => state.kind === 'reveal')
        .slice(1, 4)
        .map((state) => state.rest),
      [true, true, true],
    );
  } finally {
    await context.close();
  }
});

test('the entrance ends within 600ms, and a shift entrance is at full opacity from first paint', async () => {
  const { context, page } = await openFixture();
  try {
    const timing = await page.evaluate(() => {
      const { document, getComputedStyle } = globalThis;
      const entering = [...document.querySelectorAll('[data-enter]')];
      return entering.map((element) => {
        const [animation] = element.getAnimations();
        // Every entrance at its first frame, as first paint draws it.
        animation.pause();
        animation.currentTime = 0;
        const { endTime } = animation.effect.getComputedTiming();
        return {
          shift: element.getAttribute('data-enter') === 'shift',
          endTime,
          opacity: getComputedStyle(element).opacity,
          keyframes: animation.effect
            .getKeyframes()
            .flatMap((keyframe) => Object.keys(keyframe))
            .filter(
              (key) =>
                !['offset', 'easing', 'composite', 'computedOffset'].includes(
                  key,
                ),
            ),
        };
      });
    });
    assert.equal(timing.length, 5);
    for (const entry of timing) {
      assert.ok(entry.endTime <= 600, `ends at ${entry.endTime}ms`);
      if (entry.shift) {
        assert.equal(entry.opacity, '1', 'shift: full opacity at first paint');
        assert.deepEqual(
          [...new Set(entry.keyframes)],
          ['translate'],
          'shift only moves',
        );
      } else {
        assert.deepEqual([...new Set(entry.keyframes)].sort(), [
          'opacity',
          'translate',
        ]);
      }
    }
    // Index 6 is capped at index 3: 400ms + 3 × 60ms.
    assert.deepEqual(
      timing.map((entry) => Math.round(entry.endTime)),
      [400, 460, 520, 580, 580],
    );
  } finally {
    await context.close();
  }
});

test('focused content is never mid-motion: focus puts an entering or revealed element at rest at once', async () => {
  const { context, page } = await openFixture();
  try {
    // During the entrance, before it has ended.
    await page.locator('#email').focus();
    const form = await page.evaluate(() => {
      const element = globalThis.document.querySelector('form[data-enter]');
      const style = globalThis.getComputedStyle(element);
      return {
        translate: style.translate,
        animations: element.getAnimations().length,
      };
    });
    assert.deepEqual(form, { translate: 'none', animations: 0 });

    // Revealed content below the fold, focused without scrolling to it.
    await page.evaluate(() =>
      globalThis.document
        .querySelector('#revealed-link')
        .focus({ preventScroll: true }),
    );
    const card = await page.evaluate(() => {
      const element = globalThis.document
        .querySelector('#revealed-link')
        .closest('[data-reveal]');
      const style = globalThis.getComputedStyle(element);
      return {
        opacity: style.opacity,
        translate: style.translate,
        scrolled: globalThis.scrollY,
      };
    });
    assert.deepEqual(card, { opacity: '1', translate: 'none', scrolled: 0 });
  } finally {
    await context.close();
  }
});

// E11.5-11i (founder decisions 2026-10-31): the focus walk's check, on
// planted fixtures. Each planted page sets its own motion without the
// :focus-within rule, so the focused content is genuinely still moving.
const plantedFocusPage = (body, css = '') =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Planted</title><style>${tokensCss}
body { margin: 0; font-family: var(--font-sans); }
${css}</style></head><body><main>${body}</main></body></html>`;

async function focusIssuesOn(
  html,
  focus = async (page) => page.keyboard.press('Tab'),
) {
  const { context, page } = await openFixture({ html });
  try {
    await focus(page);
    return await focusMotionIssues(page);
  } finally {
    await context.close();
  }
}

test('the focus check fails on focus inside content that is still revealing or entering', async () => {
  const revealing = await focusIssuesOn(
    plantedFocusPage(
      '<div style="height: 2000px"></div><section data-reveal><a id="planted" href="#planted">Inside a reveal</a></section>',
      '@keyframes planted-reveal { from { opacity: 0; translate: 0 var(--reveal-distance); } } [data-reveal] { animation-name: planted-reveal; animation-duration: auto; animation-fill-mode: backwards; animation-timeline: view(); animation-range: var(--reveal-range); }',
    ),
    (page) =>
      page.evaluate(() =>
        globalThis.document
          .querySelector('#planted')
          .focus({ preventScroll: true }),
      ),
  );
  assert.ok(
    revealing.some((issue) =>
      /^section\.\(no class\) reveal planted-reveal in effect$/u.test(issue),
    ),
    JSON.stringify(revealing),
  );

  const entering = await focusIssuesOn(
    plantedFocusPage(
      '<div data-enter><a href="#">Inside an entrance</a></div>',
      '@keyframes planted-enter { from { opacity: 0; translate: 0 var(--enter-distance); } } [data-enter] { animation-name: planted-enter; animation-duration: calc(var(--duration-enter) * 20); }',
    ),
  );
  assert.ok(
    entering.some((issue) =>
      issue.includes('entrance planted-enter in effect'),
    ),
    JSON.stringify(entering),
  );
});

test('the focus check allows the focus state transition within --duration-base, and fails a slower one', async () => {
  const slide = (duration) =>
    plantedFocusPage(
      '<a class="slide" href="#">Slides in on focus</a>',
      `.slide { display: inline-block; transform: translateY(-200%); transition-property: transform; transition-duration: ${duration}; } .slide:focus { transform: translateY(0); }`,
    );
  assert.deepEqual(await focusIssuesOn(slide('var(--duration-base)')), []);
  const slow = await focusIssuesOn(slide('calc(var(--duration-base) * 3)'));
  assert.ok(
    slow.some((issue) => issue.includes('longer than --duration-base')),
    JSON.stringify(slow),
  );
});

test('a native checkbox is exempt from the opacity check only while its drawn box is opaque with a visible focus ring', async () => {
  const checkbox = (boxCss) =>
    plantedFocusPage(
      '<label><span class="control"><input type="checkbox"><span class="box" aria-hidden="true"></span></span> Planted</label>',
      `.control { position: relative; display: inline-flex; inline-size: var(--check-size); block-size: var(--check-size); } input { position: absolute; inset: 0; margin: 0; opacity: 0; } .box { inline-size: var(--check-size); block-size: var(--check-size); border: var(--border-check) solid var(--field); } input:focus-visible + .box { outline: var(--focus-width) solid var(--coral); } ${boxCss}`,
    );
  assert.deepEqual(await focusIssuesOn(checkbox('')), []);
  const faded = await focusIssuesOn(checkbox('.box { opacity: 0.5; }'));
  assert.ok(
    faded.some((issue) => issue.startsWith('span.box opacity 0.5')),
    JSON.stringify(faded),
  );
  const ringless = await focusIssuesOn(
    checkbox('input:focus-visible + .box { outline: none; }'),
  );
  assert.ok(
    ringless.some((issue) => issue.includes('shows no focus ring')),
    JSON.stringify(ringless),
  );
});

test('on the motion fixture, focus inside revealed content finds it at rest', async () => {
  const { context, page } = await openFixture();
  try {
    await page.evaluate(() =>
      globalThis.document
        .querySelector('#revealed-link')
        .focus({ preventScroll: true }),
    );
    assert.deepEqual(await focusMotionIssues(page), []);
  } finally {
    await context.close();
  }
});

test('at rest, every revealed and entering element has the same box with motion on as under reduced motion', async () => {
  const boxes = async (reducedMotion, width) => {
    const { context, page } = await openFixture({ width, reducedMotion });
    try {
      await finishEntrances(page);
      const tops = await restingTops(page);
      const measured = [];
      const count = await page.locator('[data-reveal], [data-enter]').count();
      for (let index = 0; index < count; index += 1) {
        const element = page.locator('[data-reveal], [data-enter]').nth(index);
        if (
          await element.evaluate((node) => node.hasAttribute('data-reveal'))
        ) {
          const reveal = await element.evaluate((node) =>
            [...globalThis.document.querySelectorAll('[data-reveal]')].indexOf(
              node,
            ),
          );
          await scrollToY(page, tops[reveal] - 0.7 * viewportHeight);
        } else {
          await scrollToY(page, 0);
        }
        measured.push(
          await element.evaluate((node) => {
            const style = globalThis.getComputedStyle(node);
            const rect = node.getBoundingClientRect();
            return {
              rest: style.opacity === '1' && style.translate === 'none',
              box: [
                rect.left,
                rect.top + globalThis.scrollY,
                rect.width,
                rect.height,
              ],
            };
          }),
        );
      }
      return measured;
    } finally {
      await context.close();
    }
  };
  for (const width of designWidths) {
    const moving = await boxes('no-preference', width);
    const reduced = await boxes('reduce', width);
    assert.equal(moving.length, 11);
    assert.equal(moving.length, reduced.length);
    for (const [index, entry] of moving.entries()) {
      assert.ok(entry.rest, `${width}px: element ${index + 1} is at rest`);
      entry.box.forEach((value, axis) =>
        assert.ok(
          Math.abs(value - reduced[index].box[axis]) <= tolerance,
          `${width}px: element ${index + 1} box ${entry.box} vs ${reduced[index].box}`,
        ),
      );
    }
  }
});

// The built app: motion.css loads on every page through BaseLayout, so page
// transitions and smooth scrolling apply site-wide, and only where allowed.
const siteRoutes = ['/', '/legit', '/guarantee', '/privacy', '/giveaway/rules'];

test('page transitions and smooth scrolling apply site-wide, and only without reduced motion', async () => {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const context = await browser.newContext({ reducedMotion });
    const page = await context.newPage();
    try {
      for (const route of siteRoutes) {
        const response = await page.goto(`${browserOrigin}${route}`, {
          waitUntil: 'load',
        });
        assert.equal(response.status(), 200, route);
        const state = await page.evaluate(() => {
          const rules = (list) =>
            [...list].flatMap((rule) => [
              rule,
              ...(rule.cssRules ? rules(rule.cssRules) : []),
            ]);
          const active = (rule) => {
            for (
              let parent = rule.parentRule;
              parent;
              parent = parent.parentRule
            ) {
              if (
                parent.media &&
                !globalThis.matchMedia(parent.media.mediaText).matches
              )
                return false;
            }
            return true;
          };
          return {
            scroll: globalThis.getComputedStyle(
              globalThis.document.documentElement,
            ).scrollBehavior,
            viewTransition: rules(
              [...globalThis.document.styleSheets].flatMap((sheet) => [
                ...sheet.cssRules,
              ]),
            ).some(
              (rule) =>
                rule.cssText.startsWith('@view-transition') &&
                rule.cssText.includes('auto') &&
                active(rule),
            ),
          };
        });
        assert.deepEqual(
          state,
          reducedMotion === 'reduce'
            ? { scroll: 'auto', viewTransition: false }
            : { scroll: 'smooth', viewTransition: true },
          `${route} with ${reducedMotion}`,
        );
      }
    } finally {
      await context.close();
    }
  }
});

test('a same-origin navigation cross-fades with motion allowed and starts no view transition under reduced motion', async () => {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const context = await browser.newContext({ reducedMotion });
    await context.addInitScript(() => {
      globalThis.addEventListener('pagereveal', (event) => {
        globalThis.__viewTransition = event.viewTransition !== null;
      });
    });
    const page = await context.newPage();
    try {
      await page.goto(`${browserOrigin}/legit`, { waitUntil: 'load' });
      await page.locator('body > header a.site-name').click();
      await page.waitForURL(`${browserOrigin}/`);
      // pagereveal fires at the first rendering opportunity, which can come
      // after the load event.
      await page.waitForFunction(
        () => globalThis.__viewTransition !== undefined,
      );
      assert.equal(
        await page.evaluate(() => globalThis.__viewTransition),
        reducedMotion !== 'reduce',
        reducedMotion,
      );
    } finally {
      await context.close();
    }
  }
});

test('the theme toggle cross-fades only where view transitions exist and motion is allowed', async () => {
  for (const [label, reducedMotion, supported, crossFades] of [
    ['motion allowed', 'no-preference', true, 1],
    ['reduced motion', 'reduce', true, 0],
    ['no view transitions', 'no-preference', false, 0],
  ]) {
    const context = await browser.newContext({
      colorScheme: 'light',
      reducedMotion,
    });
    await context.addInitScript((keep) => {
      globalThis.__crossFades = 0;
      const original = globalThis.Document.prototype.startViewTransition;
      if (!keep) {
        delete globalThis.Document.prototype.startViewTransition;
        return;
      }
      globalThis.Document.prototype.startViewTransition = function (update) {
        globalThis.__crossFades += 1;
        return original.call(this, update);
      };
    }, supported);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    try {
      await page.goto(browserOrigin, { waitUntil: 'load' });
      await page.getByRole('button', { name: 'Use dark theme' }).click();
      await page.waitForFunction(
        () => globalThis.document.documentElement.dataset.theme === 'dark',
      );
      assert.deepEqual(
        await page.evaluate(() => ({
          crossFades: globalThis.__crossFades,
          stored: globalThis.localStorage.getItem('valstara-theme'),
          pressed: globalThis.document
            .querySelector('valstara-theme-toggle button')
            .getAttribute('aria-pressed'),
        })),
        { crossFades, stored: 'dark', pressed: 'true' },
        label,
      );
      assert.deepEqual(errors, [], label);
    } finally {
      await context.close();
    }
  }
});

test('rapid theme toggling raises no page error, and the last toggle wins', async () => {
  const context = await browser.newContext({
    colorScheme: 'light',
    reducedMotion: 'no-preference',
  });
  await context.addInitScript(() => {
    globalThis.__transitions = [];
    const original = globalThis.Document.prototype.startViewTransition;
    globalThis.Document.prototype.startViewTransition = function (update) {
      const transition = original.call(this, update);
      globalThis.__transitions.push(transition);
      return transition;
    };
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(browserOrigin, { waitUntil: 'load' });
    await page.waitForSelector('valstara-theme-toggle button:not([disabled])');
    // Three clicks in one task: each new transition skips the one before it.
    const count = await page.evaluate(async () => {
      const button = globalThis.document.querySelector(
        'valstara-theme-toggle button',
      );
      button.click();
      button.click();
      button.click();
      await Promise.allSettled(
        globalThis.__transitions.map((transition) => transition.finished),
      );
      return globalThis.__transitions.length;
    });
    assert.equal(count, 3, 'three transitions started');
    await frames(page);
    assert.deepEqual(
      await page.evaluate(() => ({
        theme: globalThis.document.documentElement.dataset.theme,
        stored: globalThis.localStorage.getItem('valstara-theme'),
        pressed: globalThis.document
          .querySelector('valstara-theme-toggle button')
          .getAttribute('aria-pressed'),
      })),
      { theme: 'dark', stored: 'dark', pressed: 'true' },
    );
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});
