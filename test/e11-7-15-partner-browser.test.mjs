import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import axe from 'axe-core';
import { chromium } from 'playwright';

import {
  designThemes,
  designWidths,
  settlePage,
} from '../scripts/design/layout-checks.mjs';
import {
  containerOwnerArguments,
  removeOrphanedContainers,
} from './helpers/container-owner.mjs';
import { publishedPort } from './helpers/listen-port.mjs';
import { entranceEnded } from './helpers/motion.mjs';
import {
  copyIssues,
  sentenceCaseIssues,
} from './helpers/partner-copy-audit.mjs';
import {
  flagPhases,
  partnerAuditStates,
  partnerChangedSurfaces,
  partnerProgrammeRoutes,
  startPartnerAuditServer,
} from './helpers/partner-audit.mjs';
import { sourcePagePaths } from './helpers/page-inventory.mjs';
import { renderAuditedEmails } from './helpers/partner-emails.ts';
import { createPool } from '../src/server/db/pool.ts';
import { partnerApplicationRenderers } from '../src/server/partner/templates.ts';
import { partnerAuditTokenSecret } from './helpers/partner-audit.mjs';

// E11.7-15: the rendered-page half of the partner programme audit, over the
// programme the local seed writes (scripts/seed-partner-programme.ts), as
// the repository's build serves it. Every new route and every changed
// surface, in each state the seeded programme gives it
// (test/helpers/partner-audit.mjs), is checked for:
// - accessibility: axe-core's WCAG 2.2 AA rules at every design width in
//   both themes, as test/accessibility.test.mjs runs them;
// - the copy rules over the text a person reads: never-use terms (the
//   brief's banned words included), exclamation marks, unfilled
//   placeholders, urgency wording and sentence case;
// - no new island: no custom element beyond ADR-001's three is defined, no
//   framework island hydrates, and the programme's own pages define only
//   the theme toggle;
// - every new and changed email, rendered from the seeded programme, fits
//   every design width under 600px (finding E2).
// Each check fails on a planted defect. Evidence:
// docs/testing/e11-7-partner-programme-audit.md.

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const browserContainer = `valstara-e11-7-15-playwright-${process.pid}`;
const playwrightImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const wcag22aaTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const islandElements = new Set([
  'valstara-signup-form',
  'valstara-theme-toggle',
  'valstara-leaderboard',
]);

let server;
let browser;
let browserServer;
let origin;
let states;

async function startBrowserServer() {
  await removeOrphanedContainers();
  browserServer = spawn(
    'docker',
    [
      'run',
      ...containerOwnerArguments(),
      '--rm',
      '--name',
      browserContainer,
      '--add-host',
      'host.docker.internal:host-gateway',
      '--publish',
      '127.0.0.1::3000',
      '--volume',
      `${root}:/work:ro`,
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
  browserServer.stdout.setEncoding('utf8');
  browserServer.stderr.setEncoding('utf8');
  browserServer.stdout.on('data', (chunk) => (output += chunk));
  browserServer.stderr.on('data', (chunk) => (output += chunk));
  try {
    for (let attempt = 0; attempt < 720; attempt += 1) {
      if (output.includes('Listening on'))
        return `ws://127.0.0.1:${await publishedPort(browserContainer, 3000)}/`;
      if (browserServer.exitCode !== null)
        throw new Error(`The Playwright server exited.\n${output}`);
      await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
    }
    throw new Error(`The Playwright server did not start.\n${output}`);
  } catch (error) {
    await stopBrowserServer();
    throw error;
  }
}

async function stopBrowserServer() {
  await execFileAsync('docker', ['rm', '--force', browserContainer]).catch(
    (error) => {
      if (!String(error.stderr).includes('No such container')) throw error;
    },
  );
  if (browserServer !== undefined && browserServer.exitCode === null) {
    const exited = once(browserServer, 'exit');
    browserServer.kill('SIGTERM');
    await exited;
  }
}

before(async () => {
  server = await startPartnerAuditServer({
    label: 'E11.7-15 browser audit',
    host: '0.0.0.0',
  });
  origin = `http://host.docker.internal:${server.port}`;
  states = partnerAuditStates(server.manifest);
  browser = await chromium.connect(await startBrowserServer());
});

after(async () => {
  await browser?.close();
  await stopBrowserServer();
  await server?.dispose();
});

/**
 * Runs `visit` for every state, phase by phase (flag-on states first),
 * restoring the flags afterwards. A POST state's page is fetched once.
 */
async function eachState(visit) {
  const results = [];
  try {
    for (const phase of flagPhases(states)) {
      await server.setFlags({ 'partners.enabled': true, ...phase.flags });
      for (const state of phase.states) {
        const document = state.post ? await server.document(state) : null;
        results.push(...((await visit(state, document)) ?? []));
      }
    }
  } finally {
    await server.setFlags({ 'partners.enabled': true });
  }
  return results;
}

/**
 * Opens a state in a fresh context: a POST state's page is served at its
 * URL, Turnstile's loader is an empty script (the widget is Cloudflare's,
 * and the privacy crawl loads the real one), and `init` runs first.
 */
async function openState(state, document, { colorScheme, width, init }) {
  const context = await browser.newContext({
    colorScheme,
    reducedMotion: 'reduce',
    viewport: { width, height: 900 },
  });
  await context.route('https://challenges.cloudflare.com/**', (route) =>
    route
      .fulfill({ contentType: 'text/javascript', body: '' })
      .catch(() => undefined),
  );
  const target = new URL(state.path, origin).href;
  // A POST state's page is served at its URL. Every other request to the
  // app is fetched and fulfilled too: Chromium's Private Network Access
  // check otherwise blocks a fulfilled page's stylesheet from the private
  // host, as the full contact sheet found (scripts/design/full-contact-sheet.mjs).
  if (document !== null)
    await context.route(`${origin}/**`, async (route) => {
      try {
        if (
          route.request().isNavigationRequest() &&
          route.request().url() === target
        )
          return await route.fulfill({
            status: document.status,
            contentType: 'text/html; charset=utf-8',
            body: document.html,
          });
        return await route.fulfill({ response: await route.fetch() });
      } catch {
        // The context closed while this request was in flight.
        return undefined;
      }
    });
  if (init !== undefined) await context.addInitScript(init);
  const page = await context.newPage();
  const response = await page.goto(target, { waitUntil: 'load' });
  assert.ok(response, `${state.state} answers`);
  if (state.status === undefined)
    assert.ok(
      response.status() < 500,
      `${state.state} answered ${response.status()}`,
    );
  else assert.equal(response.status(), state.status, state.state);
  if (state.redirectsTo !== undefined) {
    const landed = new URL(page.url());
    assert.equal(
      `${landed.pathname}${landed.search}`,
      state.redirectsTo,
      `${state.state} redirects`,
    );
  }
  await entranceEnded(page);
  await settlePage(page);
  return { context, page };
}

// The same runner as test/accessibility.test.mjs, injected into the test
// browser only.
async function axeViolations(page) {
  await settlePage(page);
  if (!(await page.evaluate(() => 'axe' in globalThis)))
    await page.addScriptTag({ content: axe.source });
  return page.evaluate(
    async (tags) =>
      (
        await globalThis.axe.run(globalThis.document, {
          resultTypes: ['violations'],
          runOnly: { type: 'tag', values: tags },
        })
      ).violations.map((violation) => ({
        id: violation.id,
        impact: violation.impact,
        nodes: violation.nodes.map((node) => node.target.join(' ')),
      })),
    wcag22aaTags,
  );
}

async function violationsAtEveryWidth(state, document, colorScheme) {
  const { context, page } = await openState(state, document, {
    colorScheme,
    width: designWidths[0],
  });
  try {
    const found = [];
    for (const width of designWidths) {
      await page.setViewportSize({ width, height: 900 });
      const violations = await axeViolations(page);
      if (violations.length > 0)
        found.push({ state: state.state, width, colorScheme, violations });
    }
    return found;
  } finally {
    await context.close();
  }
}

// What a person reads: the page's text, and its headings and controls,
// whose case the copy rules fix.
function readCopy(page) {
  return page.evaluate(() => {
    const { document } = globalThis;
    const lines = [
      ...document.querySelectorAll(
        'h1, h2, h3, h4, button, label, legend, summary, th, title',
      ),
    ]
      .map((element) => element.textContent.replace(/\s+/gu, ' ').trim())
      .filter(Boolean);
    return {
      text: document.body.innerText,
      title: document.title,
      lines,
    };
  });
}

async function pageCopyIssues(page, label) {
  const { text, title, lines } = await readCopy(page);
  return [
    ...copyIssues(`${title}\n${text}`),
    ...lines.flatMap((line) => sentenceCaseIssues(line)),
  ].map((issue) => `${label}: ${issue}`);
}

// Records every custom element a page defines, before its scripts run.
function recordDefinitions() {
  const defined = [];
  Object.defineProperty(globalThis, '__definedElements', { value: defined });
  const define = globalThis.customElements.define.bind(
    globalThis.customElements,
  );
  globalThis.customElements.define = (name, ...rest) => {
    defined.push(name);
    return define(name, ...rest);
  };
}

async function islandIssues(page, state) {
  const { defined, frameworkIslands, scripts } = await page.evaluate(() => ({
    defined: [...globalThis.__definedElements],
    frameworkIslands:
      globalThis.document.querySelectorAll('astro-island').length,
    scripts: [...globalThis.document.querySelectorAll('script[src]')].map(
      (script) => script.src,
    ),
  }));
  const issues = [];
  const programmePage =
    partnerProgrammeRoutes.includes(state.covers) &&
    state.covers !== '/r/[code]';
  for (const name of defined) {
    if (!islandElements.has(name))
      issues.push(`${state.state}: a fourth island <${name}>`);
    else if (programmePage && name !== 'valstara-theme-toggle')
      issues.push(`${state.state}: the programme page mounts <${name}>`);
  }
  if (frameworkIslands > 0)
    issues.push(
      `${state.state}: ${frameworkIslands} hydrated framework island`,
    );
  for (const source of scripts) {
    const url = new URL(source);
    if (url.hostname === 'challenges.cloudflare.com') {
      if ((state.protectedForms ?? 0) === 0)
        issues.push(`${state.state}: Turnstile without a protected form`);
    } else if (url.origin !== new URL(origin).origin)
      issues.push(`${state.state}: a third-party script ${url.origin}`);
  }
  return issues;
}

test('every new partner programme route and changed surface is covered by an audited state', async () => {
  const covered = new Set(states.map((state) => state.covers));
  for (const route of [...partnerProgrammeRoutes, ...partnerChangedSurfaces])
    assert.ok(covered.has(route), `${route} has an audited state`);
  // Every page file under /partners is one of the programme's routes.
  const { routes } = await sourcePagePaths();
  assert.deepEqual(
    routes.filter((route) => route.startsWith('/partners')).sort(),
    partnerProgrammeRoutes
      .filter((route) => route.startsWith('/partners'))
      .sort(),
  );
  assert.ok(states.length >= 40, `${states.length} states`);
});

test('accessibility: every partner programme state has zero WCAG 2.2 AA violations at every design width in both themes', async () => {
  const found = await eachState(async (state, document) => {
    const results = [];
    for (const colorScheme of designThemes)
      results.push(
        ...(await violationsAtEveryWidth(state, document, colorScheme)),
      );
    return results;
  });
  assert.deepEqual(found, []);
});

test('copy: every partner programme state reads under the copy rules, the brief’s banned words included', async () => {
  const found = await eachState(async (state, document) => {
    const { context, page } = await openState(state, document, {
      colorScheme: 'light',
      width: 1440,
    });
    try {
      return await pageCopyIssues(page, state.state);
    } finally {
      await context.close();
    }
  });
  assert.deepEqual(found, []);
});

test('islands: no partner programme state defines a fourth island, and the programme’s own pages mount only the theme toggle', async () => {
  const found = await eachState(async (state, document) => {
    const { context, page } = await openState(state, document, {
      colorScheme: 'light',
      width: 390,
      init: recordDefinitions,
    });
    try {
      return await islandIssues(page, state);
    } finally {
      await context.close();
    }
  });
  assert.deepEqual(found, []);
});

test('each check fails on a defect planted in a real partner programme page', async () => {
  const state = states.find((entry) => entry.state === 'partners');
  const plant = (html) =>
    html.replace(
      '</main>',
      `<h2>Join The Partner Team</h2><p>Earn unlimited rewards, only 3 spots left! Your code: {code}</p><img src="/favicon.svg"><valstara-extra-island></valstara-extra-island><script>customElements.define('valstara-extra-island', class extends HTMLElement {})</script><script src="https://cdn.example.com/widget.js"></script></main>`,
    );
  const served = await (
    await globalThis.fetch(`${server.local}/partners`)
  ).text();
  const planted = { status: 200, html: plant(served) };
  assert.notEqual(planted.html, served, 'the defect is planted');
  const { context, page } = await openState(state, planted, {
    colorScheme: 'light',
    width: 1440,
    init: recordDefinitions,
  });
  try {
    const copy = await pageCopyIssues(page, 'planted');
    for (const expected of [
      /forbidden term "unlimited"/u,
      /forbidden term "team"/u,
      /exclamation mark/u,
      /placeholder/u,
      /urgency/u,
      /"Partner" in "Join The Partner Team"/u,
    ])
      assert.ok(
        copy.some((issue) => expected.test(issue)),
        `${expected} in ${copy.join('; ')}`,
      );
    const islands = await islandIssues(page, state);
    assert.ok(islands.some((issue) => /a fourth island/u.test(issue)));
    assert.ok(islands.some((issue) => /third-party script/u.test(issue)));
    const violations = await axeViolations(page);
    assert.ok(
      violations.some((violation) => violation.id === 'image-alt'),
      JSON.stringify(violations),
    );
  } finally {
    await context.close();
  }
});

// Runs last: rendering the emails issues a replacement dashboard link, which
// cancels the active standard partner's seeded one.
test('emails: every new and changed email fits every narrow design width, a 16-character partner code on the public origin included', async () => {
  const database = createPool(server.databaseUrl);
  let rendered;
  try {
    rendered = await renderAuditedEmails(database, {
      baseUrl: server.local,
      tokenSecret: partnerAuditTokenSecret,
      actor: 'founder:e11-7-15-audit',
    });
  } finally {
    await database.close();
  }
  // One message per template, and the longest a partner welcome can be: a
  // code at the 16-character maximum, on the public origin (finding E2).
  const messages = new Map();
  for (const { row, message } of rendered)
    if (!messages.has(row.template)) messages.set(row.template, message);
  const longest = await partnerApplicationRenderers(
    'https://valstara.com',
    'send.valstara.com',
    { welcomeCode: async () => 'ABCDEFGHJKMNPQRS' },
  )
    .get('partner_welcome')
    .render({
      email: 'reader@example.test',
      payload: { token_id: 'dashboard-id' },
      token: async (id) => `${id}-${'x'.repeat(43)}`,
      unsubscribePageUrl: `https://valstara.com/unsubscribe?t=${'u'.repeat(43)}`,
    });
  messages.set('partner_welcome, 16-character code', longest);

  const found = [];
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  try {
    const page = await context.newPage();
    for (const [label, message] of messages)
      for (const width of designWidths.filter((value) => value < 600))
        for (const colorScheme of designThemes) {
          await page.emulateMedia({ colorScheme });
          await page.setViewportSize({ width, height: 900 });
          await page.setContent(message.html, { waitUntil: 'load' });
          const scrollWidth = await page.evaluate(
            () => globalThis.document.documentElement.scrollWidth,
          );
          if (scrollWidth > width)
            found.push(
              `${label} at ${width}px ${colorScheme}: ${scrollWidth}px`,
            );
        }
  } finally {
    await context.close();
  }
  assert.ok(messages.size >= 12, `${messages.size} messages`);
  assert.deepEqual(found, []);
});
