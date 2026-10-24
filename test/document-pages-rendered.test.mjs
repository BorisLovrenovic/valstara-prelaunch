// E11.5-09: the trust, legal and giveaway-rules pages on the document layout.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';

import axe from 'axe-core';
import { chromium } from 'playwright';

import {
  checkPageLayout,
  designThemes,
  designWidths,
  enforcedPages,
} from '../scripts/design/layout-checks.mjs';
import { publishedPort, startAppServer } from './helpers/listen-port.mjs';

const executeFile = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const browserImage =
  'mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e';
const browserContainer = 'valstara-document-pages-' + process.pid;

const rulesVersions = [
  'VAL-GW-LAUNCH-20260925-r1',
  'VAL-GW-LAUNCH-20261001-r1',
  'VAL-GW-LAUNCH-20261009-r1',
];
const currentRulesVersion = 'VAL-GW-LAUNCH-20261009-r1';
const trustRoutes = ['/legit', '/guarantee', '/about'];
const legalRoutes = ['/terms', '/privacy', '/privacy/storage'];
const rulesRoutes = [
  '/giveaway/rules',
  ...rulesVersions.map((version) => `/giveaway/rules/${version}`),
];
const routes = [...trustRoutes, ...legalRoutes, ...rulesRoutes];
const tableRoutes = ['/legit', '/privacy', '/privacy/storage'];

// Every content file as it stood when E11.5-09 began. E11.5 changes no
// content file; a new rules revision may be added, but none listed here may
// change or disappear.
const recordedContent = new Map([
  [
    'src/content/.gitkeep',
    '01ba4719c80b6fe911b091a7c05124b64eeece964e09c058ef8f9805daca546b',
  ],
  [
    'src/content/about.md',
    'f24de7bc9fc3271d8a069ad1239113951409840076ed9cbdd3054da6a9519171',
  ],
  [
    'src/content/giveaway-award-catalog.json',
    '5b2263fb70a20c4b06ed274362a62e9eb6106e0fb7edca870c7e57d79a490601',
  ],
  [
    'src/content/giveaway-rules/VAL-GW-LAUNCH-20260925-r1.md',
    'd323c31cb420e883c8b75fa10a474521ddc3923cefa6b3aeb916083b71a7a197',
  ],
  [
    'src/content/giveaway-rules/VAL-GW-LAUNCH-20261001-r1.md',
    'ae2d7b3e1f69103b7904d7169b2959e729873292488d2d4391150efa72326ae6',
  ],
  [
    'src/content/giveaway-rules/VAL-GW-LAUNCH-20261009-r1.md',
    '9f2141982e7f41f9c6c7add9316196939f93e2ac367707e9fd3acaeb0b610ac4',
  ],
  [
    'src/content/guarantee.md',
    '8ff5fc30be69fcb3781b3940a60d533d8a45728cd97887c19947642ef8b494f4',
  ],
  [
    'src/content/legit.md',
    '8323133f8032fe6ed0ef1e41913b993eebb1c38df394aa3897fb8879d5b4646a',
  ],
  [
    'src/content/privacy-storage.md',
    'a26ef1a04019797cd796d871207d713ddd54ebb3160bcc790924acfafe047ab4',
  ],
  [
    'src/content/privacy.md',
    '2ca8d50e0b117ed7100a558a479b910031d689a446f86b51ec3772bd8b89a8b5',
  ],
  [
    'src/content/terms.md',
    '6f405982f1c891e50d659579c6f7f95c97a0d3b1b3ca6997c19aa93dc96cbaf8',
  ],
]);

const articlePattern =
  /<article\b[^>]*data-rules-version="([^"]+)"[^>]*data-rules-sha256="([a-f0-9]{64})"[^>]*>([\s\S]*?)<\/article>/u;

let app;
let browserServer;
let browser;
let origin;
let hostOrigin;
const html = new Map();

async function frontmatterValue(file, key) {
  const source = await readFile(join(root, file), 'utf8');
  const value = new RegExp(`^${key}: (.+)$`, 'mu').exec(source)?.[1];
  assert.ok(value, `${file} has no ${key}`);
  return value.replace(/^'(.*)'$/u, '$1');
}

// The summary each page must show, read from its own source: the content
// description for trust and rules pages, the legal.ts entry for legal pages.
async function expectedSummary(route) {
  if (trustRoutes.includes(route))
    return frontmatterValue(`src/content${route}.md`, 'description');
  if (route.startsWith('/giveaway/rules')) {
    const version = route.split('/')[3] ?? currentRulesVersion;
    return frontmatterValue(
      `src/content/giveaway-rules/${version}.md`,
      'description',
    );
  }
  const { legalPageCopy } = await import('../src/copy/legal.ts');
  const key = { '/terms': 'terms', '/privacy': 'privacy' }[route] ?? 'storage';
  return legalPageCopy[key].description;
}

function textOf(fragment) {
  return fragment
    .replace(/<[^>]+>/gu, '')
    .replace(/&#x27;|&#39;/gu, "'")
    .replace(/&amp;/gu, '&')
    .replace(/\s+/gu, ' ')
    .trim();
}

before(async () => {
  await executeFile('npm', ['run', 'build'], { cwd: root });
  app = await startAppServer({
    label: 'Document pages',
    readyPath: '/legit',
    env: () => ({
      ADMIN_CREDENTIAL: 'document-pages-admin-credential-32-chars',
      ADMIN_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ??
        'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres',
      HOST: '0.0.0.0',
      IP_PREFIX_PEPPER: 'document-pages-prefix-pepper',
      REFERRAL_SIGNING_SECRET: 'document-pages-referral-secret',
      RESEND_API_KEY: 'document-pages-resend-key',
      RESEND_DKIM_EXPECTED_VALUE: 'p=test-public-key',
      RESEND_KEY_MODE: 'test',
      RESEND_RSEND_CNAME_EXPECTED_TARGET: 'rsend-euw1.forge.rmta.net',
      RESEND_SEND_CNAME_EXPECTED_TARGET: 'send.forge.rmta.net',
      RESEND_SENDING_DOMAIN: 'send.valstara.com',
      TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
    }),
  });
  hostOrigin = 'http://127.0.0.1:' + app.port;
  origin = 'http://host.docker.internal:' + app.port;
  for (const route of routes) {
    const response = await globalThis.fetch(hostOrigin + route);
    assert.equal(response.status, 200, route);
    html.set(route, await response.text());
  }

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
      root + ':/work:ro',
      '--workdir',
      '/work',
      browserImage,
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
    attempt < 240 && !output.includes('Listening on');
    attempt += 1
  ) {
    if (browserServer.exitCode !== null) throw new Error(output);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  }
  assert.match(output, /Listening on/u);
  browser = await chromium.connect(
    'ws://127.0.0.1:' + (await publishedPort(browserContainer, 3000)) + '/',
  );
});

after(async () => {
  await browser?.close();
  await executeFile('docker', ['rm', '--force', browserContainer]).catch(
    () => {},
  );
  if (browserServer && browserServer.exitCode === null) {
    const exited = once(browserServer, 'exit');
    browserServer.kill('SIGTERM');
    await exited;
  }
  await app?.stop();
});

test('no content file changed: every recorded file is byte-identical', async () => {
  const present = (
    await readdir(join(root, 'src/content'), { recursive: true })
  )
    .map((path) => `src/content/${path.replaceAll('\\', '/')}`)
    .filter((path) => /\.[a-z]+$/u.test(path) || path.endsWith('.gitkeep'));
  for (const [file, sha256] of recordedContent) {
    assert.ok(present.includes(file), `${file} was deleted`);
    const actual = createHash('sha256')
      .update(await readFile(join(root, file)))
      .digest('hex');
    assert.equal(actual, sha256, `${file} was edited`);
  }
});

test('every served rules article still matches its recorded SHA-256', async () => {
  for (const route of rulesRoutes) {
    const article = articlePattern.exec(html.get(route));
    assert.ok(article, `${route} has no rules article`);
    const version = route.split('/')[3] ?? currentRulesVersion;
    assert.equal(article[1], version);
    assert.equal(
      createHash('sha256').update(article[3], 'utf8').digest('hex'),
      article[2],
      route,
    );
    assert.equal(
      article[2],
      await frontmatterValue(
        `src/content/giveaway-rules/${version}.md`,
        'sha256',
      ),
    );
    // Every addition sits outside the hashed article.
    assert.doesNotMatch(article[3], /document__|data-document-/u);
  }
  // Superseded revisions keep their archived notice, outside the article and
  // ahead of the band; the current one has none.
  for (const route of rulesRoutes) {
    const page = html.get(route);
    const archived =
      !route.endsWith(currentRulesVersion) && route.includes('VAL-');
    assert.equal(/data-archived-rules-notice/u.test(page), archived, route);
    if (archived)
      assert.ok(
        page.indexOf('data-archived-rules-notice') <
          page.indexOf('data-document-eyebrow'),
      );
  }
});

test('exactly one H1, from the content, framed by the eyebrow and the summary', async () => {
  const { documentPagesCopy } = await import('../src/copy/document-pages.ts');
  for (const route of routes) {
    const page = html.get(route);
    assert.equal(page.match(/<h1\b/gu)?.length, 1, `${route} H1 count`);
    const kind = trustRoutes.includes(route)
      ? 'trust'
      : legalRoutes.includes(route)
        ? 'legal'
        : 'rules';
    // The eyebrow is immediately followed by the content article, whose first
    // child is the H1; the summary immediately follows the article.
    const band =
      /<p class="document__eyebrow" data-document-eyebrow>([^<]*)<\/p>\s*<article\b[^>]*class="document__prose"[^>]*>\s*<h1\b[^>]*>([\s\S]*?)<\/h1>[\s\S]*?<\/article>\s*<p class="document__summary" data-document-summary>([^<]*)<\/p>/u.exec(
        page,
      );
    assert.ok(band, `${route} band structure`);
    assert.equal(band[1], documentPagesCopy.eyebrow[kind], route);
    assert.equal(
      textOf(band[3]),
      await expectedSummary(route),
      `${route} summary source`,
    );
    assert.ok(textOf(band[2]).length > 0);
  }
});

test('these pages ship no client JavaScript beyond the page-view emitter and theme toggle', async () => {
  const { themeBootstrapScript } =
    await import('../src/islands/theme-toggle.ts');
  for (const route of routes) {
    let page = html.get(route);
    const dataBlocks = [
      ...page.matchAll(
        /<script type="application\/ld\+json">[\s\S]*?<\/script>/gu,
      ),
    ];
    for (const block of dataBlocks) page = page.replace(block[0], '');
    const emitter =
      /<script defer src="\/page-view\.js" data-website-id="[a-f0-9-]{36}"><\/script>/u.exec(
        page,
      );
    assert.ok(emitter, `${route} needs the page-view emitter`);
    page = page.replace(emitter[0], '');
    if (rulesRoutes.includes(route)) {
      // Rules pages keep the shell's theme toggle, unchanged.
      page = page.replace(`<script>${themeBootstrapScript}</script>`, '');
      const modules = [
        ...page.matchAll(/<script type="module">([\s\S]*?)<\/script>/gu),
      ];
      assert.equal(modules.length, 1, route);
      assert.match(modules[0][1], /valstara-theme-toggle/u);
      page = page.replace(modules[0][0], '');
      assert.equal(page.match(/<valstara-theme-toggle\b/gu)?.length, 1);
    }
    assert.doesNotMatch(page, /<script\b/iu, `${route} ships extra script`);
    assert.doesNotMatch(
      page,
      /\son[a-z]+=/iu,
      `${route} has an inline handler`,
    );
    assert.doesNotMatch(page, /<valstara-(?!theme-toggle)/u, route);
  }
});

test('the join bar is a link on the trust pages only', () => {
  for (const route of routes) {
    const page = html.get(route);
    const bar =
      /<div class="document-join-bar" data-join-bar>([\s\S]*?)<\/div>/u.exec(
        page,
      );
    assert.equal(Boolean(bar), trustRoutes.includes(route), route);
    if (!bar) continue;
    assert.match(bar[1], /^\s*<a\b[^>]*href="\/#join"[^>]*>[^<]+<\/a>\s*$/u);
    assert.doesNotMatch(bar[1], /<(?:form|input|button)\b/u);
  }
});

test('contents lists link only to heading anchors already in the content', () => {
  for (const route of routes) {
    const page = html.get(route);
    const nav = /<nav class="document__aside"[^>]*>([\s\S]*?)<\/nav>/u.exec(
      page,
    );
    const article =
      /<article\b[^>]*class="document__prose"[^>]*>([\s\S]*?)<\/article>/u.exec(
        page,
      )[1];
    const anchors = [
      ...article.matchAll(/<h2\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/h2>/gu),
    ].map((match) => [match[1], textOf(match[2])]);
    if (trustRoutes.includes(route)) {
      assert.equal(nav, null, `${route} carries the guarantee card instead`);
      assert.match(page, /data-document-card="guarantee"/u);
      continue;
    }
    if (anchors.length === 0) {
      assert.equal(nav, null, `${route} has no anchors, so no contents`);
      continue;
    }
    assert.ok(nav, `${route} needs a contents list`);
    const links = [
      ...nav[1].matchAll(/<a href="#([^"]+)">([\s\S]*?)<\/a>/gu),
    ].map((match) => [match[1], textOf(match[2])]);
    assert.deepEqual(links, anchors, route);
  }
  // The two pages whose content has no section heading show no list.
  for (const route of ['/terms', '/privacy/storage'])
    assert.doesNotMatch(html.get(route), /data-document-card="contents"/u);
  assert.match(html.get('/privacy'), /data-document-card="contents"/u);
  assert.match(html.get('/giveaway/rules'), /data-document-card="contents"/u);
});

test('no content element is hidden, the band reads eyebrow, title, summary, and anchors resolve', async () => {
  for (const route of routes) {
    for (const width of [320, 1440]) {
      for (const colorScheme of designThemes) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          colorScheme,
        });
        try {
          const page = await context.newPage();
          await page.goto(origin + route);
          const result = await page.evaluate(() => {
            const document = globalThis.document;
            const article = document.querySelector('article.document__prose');
            const hidden = [article, ...article.querySelectorAll('*')]
              .filter((element) => {
                const style = globalThis.getComputedStyle(element);
                if (element === article) return style.display === 'none';
                return (
                  style.display === 'none' ||
                  style.visibility !== 'visible' ||
                  Number(style.opacity) === 0 ||
                  element.getClientRects().length === 0
                );
              })
              .map((element) => element.tagName);
            const box = (selector) =>
              document.querySelector(selector).getBoundingClientRect();
            const eyebrow = box('[data-document-eyebrow]');
            const title = box('article.document__prose > h1');
            const summary = box('[data-document-summary]');
            const next = article.children[1]?.getBoundingClientRect();
            const missingTargets = [
              ...document.querySelectorAll('.document__contents a'),
            ]
              .map((link) => link.getAttribute('href').slice(1))
              .filter((id) => !article.querySelector(`[id="${id}"]`));
            return {
              hidden,
              h1Count: document.querySelectorAll('h1').length,
              order:
                eyebrow.bottom <= title.top + 1 &&
                title.bottom <= summary.top + 1 &&
                (!next || summary.bottom <= next.top + 1),
              missingTargets,
            };
          });
          const label = `${route} ${width}px ${colorScheme}`;
          assert.deepEqual(result.hidden, [], `${label} hides content`);
          assert.equal(result.h1Count, 1, label);
          assert.ok(result.order, `${label} band order`);
          assert.deepEqual(result.missingTargets, [], label);
        } finally {
          await context.close();
        }
      }
    }
  }
});

test('no table causes page-level horizontal overflow at any test width', async () => {
  for (const route of tableRoutes) {
    for (const width of designWidths) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
      });
      try {
        const page = await context.newPage();
        await page.goto(origin + route);
        const result = await page.evaluate(() => {
          const document = globalThis.document;
          const tables = [
            ...document.querySelectorAll('.document__prose table'),
          ];
          return {
            tables: tables.length,
            pageOverflow:
              document.documentElement.scrollWidth >
              document.documentElement.clientWidth,
            outside: tables.filter((table) => {
              const own = table.getBoundingClientRect();
              const column = document
                .querySelector('.document__main')
                .getBoundingClientRect();
              return own.right > column.right + 1 || own.left < column.left - 1;
            }).length,
            scrollContainers: tables.filter(
              (table) =>
                globalThis.getComputedStyle(table).overflowX === 'auto',
            ).length,
          };
        });
        assert.ok(result.tables > 0, `${route} has a table`);
        assert.equal(result.pageOverflow, false, `${route} ${width}px`);
        assert.equal(result.outside, 0, `${route} ${width}px`);
        assert.equal(result.scrollContainers, result.tables);
      } finally {
        await context.close();
      }
    }
  }
});

test('the join bar shows below 40rem only', async () => {
  // 639 and 640 pin the 40rem edge, which the design widths skip (390 → 768).
  for (const width of [...designWidths, 639, 640]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
    });
    try {
      const page = await context.newPage();
      await page.goto(origin + '/legit');
      const visible = await page.locator('[data-join-bar]').isVisible();
      assert.equal(visible, width < 640, `${width}px`);
    } finally {
      await context.close();
    }
  }
});

test('every page is in the enforced layout-check set and passes it at every width in both themes', async () => {
  for (const route of routes) assert.ok(enforcedPages.includes(route), route);
  for (const route of routes) {
    for (const width of designWidths) {
      for (const colorScheme of designThemes) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          colorScheme,
        });
        try {
          const page = await context.newPage();
          await page.goto(origin + route);
          assert.deepEqual(
            await checkPageLayout(page),
            [],
            `${route} ${width}px ${colorScheme}`,
          );
        } finally {
          await context.close();
        }
      }
    }
  }
});

test('every page passes axe at small and large widths in both themes', async () => {
  for (const route of routes) {
    for (const width of [320, 1440]) {
      for (const colorScheme of designThemes) {
        const context = await browser.newContext({
          viewport: { width, height: 900 },
          colorScheme,
        });
        try {
          const page = await context.newPage();
          await page.goto(origin + route);
          await page.addScriptTag({ content: axe.source });
          const violations = await page.evaluate(async () =>
            (
              await globalThis.axe.run(globalThis.document, {
                runOnly: {
                  type: 'tag',
                  values: [
                    'wcag2a',
                    'wcag2aa',
                    'wcag21a',
                    'wcag21aa',
                    'wcag22aa',
                  ],
                },
              })
            ).violations.map((violation) => violation.id),
          );
          assert.deepEqual(
            violations,
            [],
            `${route} ${width}px ${colorScheme}`,
          );
        } finally {
          await context.close();
        }
      }
    }
  }
});
