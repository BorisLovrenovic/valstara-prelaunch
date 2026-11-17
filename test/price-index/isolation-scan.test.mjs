import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { scanPriceIndexIsolation } from '../../scripts/ci/price-index-isolation.mjs';

// E11.6-02: the price-index isolation scan (ADR-033). Each red path plants a
// fixture file that breaks one rule; each green path plants the nearest
// permitted shape, so the scan cannot pass by flagging everything.

const projectRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

const siteScripts = {
  build: 'astro build',
  dev: 'astro dev',
  preview: 'astro preview',
  'price-index': 'tsx packages/price-index/src/cli/main.ts',
  check: 'npm run price-index -- validate && npm run lint',
};

function scan(files, scripts = siteScripts) {
  return scanPriceIndexIsolation(files, { scripts });
}

function assertFlags(files, pattern, scripts) {
  const issues = scan(files, scripts);
  assert.ok(
    issues.some(
      (found) =>
        found.scan === 'price-index-isolation' &&
        pattern.test(`${found.path}: ${found.message}`),
    ),
    `expected an issue matching ${pattern}, got ${JSON.stringify(issues)}`,
  );
}

function assertClean(files, scripts) {
  assert.deepEqual(scan(files, scripts), []);
}

test('the committed repository passes the isolation scan', async () => {
  const paths = execFileSync('git', ['ls-files', '-z'], {
    cwd: projectRoot,
    encoding: 'utf8',
  })
    .split('\0')
    .filter((path) =>
      /(?:^src\/|^packages\/price-index\/src\/|Dockerfile$|compose[^/]*\.ya?ml$|^\.github\/workflows\/)/.test(
        path,
      ),
    )
    .filter((path) => !/\.(?:png|jpe?g|webp|woff2?|ico|avif)$/.test(path));
  const files = await Promise.all(
    paths.map(async (path) => ({
      path,
      content: await readFile(resolve(projectRoot, path), 'utf8'),
    })),
  );
  const packageJson = JSON.parse(
    await readFile(resolve(projectRoot, 'package.json'), 'utf8'),
  );
  assert.deepEqual(scanPriceIndexIsolation(files, packageJson), []);
});

test('src/ may import only the publish and schema entry points', () => {
  assertClean([
    {
      path: 'src/server/prices/view.ts',
      content: [
        "import { configSetSchema } from '../../../packages/price-index/src/schema/index.ts';",
        "import type { Market } from '../../../packages/price-index/src/schema/markets.ts';",
        "export { publishedView } from '../../../packages/price-index/src/publish/index.ts';",
        "import { thing } from '../../../packages/price-index/src/publish.ts';",
      ].join('\n'),
    },
  ]);

  for (const [path, content, target] of [
    [
      'src/server/prices/view.ts',
      "import { runCli } from '../../../packages/price-index/src/cli/main.ts';",
      'src/cli/main.ts',
    ],
    [
      'src/pages/prices/[service]/[country].astro',
      "---\nimport { fetchPage } from '../../../../packages/price-index/src/http/fetcher.ts';\n---\n<p />",
      'src/http/fetcher.ts',
    ],
    [
      'src/server/prices/lazy.ts',
      "export const load = () => import('../../../packages/price-index/src/sources/youfundceo.ts');",
      'src/sources/youfundceo.ts',
    ],
    [
      'src/server/prices/reports.ts',
      "export * from '../../../packages/price-index/src/reports/index.ts';",
      'src/reports/index.ts',
    ],
    [
      'src/server/prices/package.ts',
      "import '../../../packages/price-index/package.json';",
      'package.json',
    ],
    [
      'src/server/prices/root.ts',
      "import { x } from '/packages/price-index/src/pipeline/merge.ts';",
      'src/pipeline/merge.ts',
    ],
  ]) {
    assertFlags(
      [{ path, content }],
      new RegExp(
        `^${path.replace(/[[\]./]/g, '\\$&')}: imports .*${target.replace(/\./g, '\\.')}; the site may import only`,
      ),
    );
  }

  // A bare specifier naming the tool cannot be resolved, so it fails closed.
  assertFlags(
    [
      {
        path: 'src/server/prices/alias.ts',
        content: "import { scrape } from '@valstara/price-index/cli';",
      },
    ],
    /imports @valstara\/price-index\/cli, which is not a path the scan can check/,
  );
});

test('the package imports nothing from src/', () => {
  assertClean([
    {
      path: 'packages/price-index/src/cli/main.ts',
      content:
        "import { validateConfig } from './validate.ts';\nimport { z } from 'zod';\nimport { x } from '../schema/index.ts';",
    },
    {
      // The founder's verbatim capture is third-party HTML, not package code.
      path: 'packages/price-index/test/fixtures/youfundceo/pages/x.server.mjs',
      content: "import x from '../../../../../../src/server/config.ts';",
    },
  ]);

  assertFlags(
    [
      {
        path: 'packages/price-index/src/pipeline/merge.ts',
        content:
          "import { flags } from '../../../../src/server/flags/index.ts';",
      },
    ],
    /^packages\/price-index\/src\/pipeline\/merge\.ts: imports \.\.\/\.\.\/\.\.\/\.\.\/src\/server\/flags\/index\.ts from the site/,
  );
  assertFlags(
    [
      {
        path: 'packages/price-index/src/copy.ts',
        content: "const copy = await import('../../../src/copy/prices.ts');",
      },
    ],
    /imports \.\.\/\.\.\/\.\.\/src\/copy\/prices\.ts from the site/,
  );
  assertFlags(
    [
      {
        path: 'packages/price-index/test/helper.mjs',
        content: "import { db } from '/src/server/db/pool.ts';",
      },
    ],
    /imports \/src\/server\/db\/pool\.ts from the site/,
  );
});

test('the Dockerfile neither references nor copies the tool', () => {
  assertClean([
    {
      path: 'Dockerfile',
      content: [
        'COPY package.json package-lock.json ./',
        'COPY src ./src',
        'COPY packages/price-index/src/schema ./packages/price-index/src/schema',
        'COPY packages/price-index/src/publish ./packages/price-index/src/publish',
        'COPY --chown=node:node --from=build /app/dist ./dist',
      ].join('\n'),
    },
  ]);

  for (const [line, pattern] of [
    [
      'COPY . .',
      /^Dockerfile: copies \., which would include the price-index tool/,
    ],
    ['COPY ./ /app/', /^Dockerfile: copies \.\/, which would include/],
    [
      'COPY packages ./packages',
      /^Dockerfile: copies packages, which would include/,
    ],
    [
      'ADD --chown=node:node packages/ /app/packages/',
      /^Dockerfile: copies packages\/, which/,
    ],
    [
      'COPY packages/price-index ./packages/price-index',
      /^Dockerfile: references the price-index tool \(packages\/price-index\)/,
    ],
    [
      'COPY packages/price-index/src/cli \\\n  ./cli',
      /^Dockerfile: copies packages\/price-index\/src\/cli, which/,
    ],
    [
      'RUN npm run price-index -- scrape',
      /^Dockerfile: references the price-index tool \(run price-index\)/,
    ],
  ]) {
    assertFlags(
      [{ path: 'Dockerfile', content: `FROM node\n${line}\n` }],
      pattern,
    );
  }

  assertFlags(
    [{ path: 'infra/backups/tool.Dockerfile', content: 'COPY . /app\n' }],
    /^infra\/backups\/tool\.Dockerfile: copies \./,
  );
});

test('no Compose file, CI workflow or crontab references the tool', () => {
  assertClean([
    {
      path: 'infra/compose/docker-compose.yml',
      content: "services:\n  app:\n    command: ['npm', 'run', 'dev']\n",
    },
    {
      path: '.github/workflows/pr.yml',
      content: 'jobs:\n  check:\n    steps:\n      - run: npm run lint\n',
    },
  ]);

  for (const [path, content] of [
    [
      'infra/compose/docker-compose.production.yml',
      'services:\n  prices:\n    command: npm run price-index -- scrape\n',
    ],
    [
      'infra/compose/docker-compose.ci.yml',
      'services:\n  prices:\n    command: tsx packages/price-index/src/cli/main.ts scrape\n',
    ],
    [
      'scripts/load/compose.load.yaml',
      'services:\n  prices:\n    volumes:\n      - ../../packages/price-index:/tool\n',
    ],
    [
      '.github/workflows/price-index.yml',
      "on:\n  schedule:\n    - cron: '0 3 1 * *'\njobs:\n  run:\n    steps:\n      - run: npm run price-index -- scrape\n",
    ],
    [
      '.github/workflows/pr.yml',
      'jobs:\n  check:\n    steps:\n      - run: npm run price-index -- validate\n',
    ],
    [
      'infra/deploy/crontab',
      '0 3 1 * * cd /app && npm run price-index -- scrape\n',
    ],
  ]) {
    assertFlags(
      [{ path, content }],
      new RegExp(
        `^${path.replace(/[./]/g, '\\$&')}: references the price-index tool`,
      ),
    );
  }
});

test('the dev, start, build and preview scripts and their hooks never reach the tool', () => {
  // `check` runs `price-index validate` by design: it is not a site script.
  assertClean([], siteScripts);

  for (const [scripts, name] of [
    [
      {
        ...siteScripts,
        build: 'npm run price-index -- build-data && astro build',
      },
      'build',
    ],
    [
      {
        ...siteScripts,
        prebuild: 'tsx packages/price-index/src/cli/main.ts validate',
      },
      'prebuild',
    ],
    [
      {
        ...siteScripts,
        dev: 'npm run fetch-prices && astro dev',
        'fetch-prices': 'npm run price-index -- scrape',
      },
      'fetch-prices',
    ],
    [
      {
        ...siteScripts,
        start: 'npm start-tool',
        'start-tool': 'x',
        poststart: 'npm run price-index',
      },
      'poststart',
    ],
    [
      {
        ...siteScripts,
        preview: 'npm run warm && astro preview',
        warm: 'echo',
        postwarm: 'node packages/price-index/src/cli/main.ts',
      },
      'postwarm',
    ],
  ]) {
    assertFlags(
      [],
      new RegExp(
        `^package\\.json: script "${name}" references the price-index tool`,
      ),
      scripts,
    );
  }
});

test('the scan is wired into npm run security', async () => {
  const gates = await readFile(
    resolve(projectRoot, 'scripts/ci/security-gates.mjs'),
    'utf8',
  );
  assert.match(
    gates,
    /import \{ scanPriceIndexIsolation \} from '\.\/price-index-isolation\.mjs';/,
  );
  assert.match(gates, /scanPriceIndexIsolation\(files, packageJson\)/);

  const redPaths = JSON.parse(
    await readFile(
      resolve(projectRoot, 'test/fixtures/security/gates.json'),
      'utf8',
    ),
  );
  assert.ok(
    redPaths['price-index-isolation'],
    'the wired red path fixture is registered',
  );
});
