import assert from 'node:assert/strict';
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import * as prettier from 'prettier';

import { runCli } from '../../packages/price-index/src/cli/main.ts';
import { parseReviewArguments } from '../../packages/price-index/src/cli/review.ts';
import { mergePriceIndex } from '../../packages/price-index/src/pipeline/index.ts';
import {
  approvalsFileSchema,
  catalogueFileSchema,
  marketsFileSchema,
  type ApprovalsFile,
  type PriceRecord,
} from '../../packages/price-index/src/schema/index.ts';
import {
  appendApproval,
  createJsonFileStore,
  serialiseApprovals,
} from '../../packages/price-index/src/storage/index.ts';
import {
  clockAt,
  decision,
  observation,
  priceOverride,
  record,
  run,
  scraper,
  settings,
} from '../helpers/price-index-merge.ts';

// E11.6-06: `price-index review approve|reject --market --service --plan
// --actor`. In this ticket it reads the flagged record from latest.json
// (D-028 Q4) and appends one decision to approvals.json, bound to the exact
// value and source the record shows (Q1). It refuses before writing anything
// without an actor, for a record that is not flagged, and for a value that
// breaks a check (Q3 a).

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const decidedAt = '2026-12-01T10:15:00.000Z';
const unpriced = {
  price_local: null,
  price_source_text: null,
  currency: null,
  price_usd_source: null,
} as const;

const flagged: PriceRecord[] = [
  record({
    price_local: '149.00',
    status: 'conflict',
    notes: 'Conflict: the manual override says 159.00 SEK.',
  }),
  record({
    service_id: 'netflix',
    plan_id: 'standard',
    price_local: '199.00',
    status: 'needs_review',
  }),
  record({
    service_id: 'netflix',
    plan_id: 'basic',
    price_local: '13.99',
    price_source_text: '€13.99',
    currency: 'EUR',
    status: 'needs_review',
  }),
  record({
    service_id: 'netflix',
    plan_id: 'premium',
    price_local: '0.00',
    status: 'needs_review',
  }),
  record({ market: 'US', price_local: '11.99', currency: 'USD' }),
  record({
    market: 'DE',
    ...unpriced,
    status: 'needs_review',
    notes: 'Disappeared from the source; the last value was 10.99 EUR.',
  }),
];

interface Workspace {
  root: string;
  approvalsPath: string;
  review(args: string[]): Promise<{ status: number; out: string; err: string }>;
  dispose(): Promise<void>;
}

async function workspace(
  options: { latest?: PriceRecord[] | null } = {},
): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), 'valstara-price-review-'));
  await cp(join(projectRoot, 'config'), join(root, 'config'), {
    recursive: true,
  });
  const directory = join(root, 'data/price-index');
  await mkdir(directory, { recursive: true });
  await cp(
    join(projectRoot, 'data/price-index/approvals.json'),
    join(directory, 'approvals.json'),
  );
  const latest = options.latest === undefined ? flagged : options.latest;
  if (latest !== null) {
    await createJsonFileStore({ directory }).writeLatest({
      built_at: '2026-12-01T09:30:00.000Z',
      records: latest,
    });
  }
  return {
    root,
    approvalsPath: join(directory, 'approvals.json'),
    async review(args) {
      const out: string[] = [];
      const err: string[] = [];
      const status = await runCli(['review', ...args], {
        root,
        stdout: (text) => out.push(text),
        stderr: (text) => err.push(text),
        clock: clockAt(decidedAt),
      });
      return { status, out: out.join(''), err: err.join('') };
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

function flags(
  market: string,
  service: string,
  plan: string,
  actor?: string,
): string[] {
  const list = ['--market', market, '--service', service, '--plan', plan];
  return actor === undefined ? list : [...list, '--actor', actor];
}

async function approvals(path: string): Promise<ApprovalsFile> {
  return approvalsFileSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

test('review approve on a conflict appends one decision bound to the exact value and source shown', async () => {
  const space = await workspace();
  try {
    const result = await space.review([
      'approve',
      ...flags('SE', 'spotify', 'individual', 'Founder'),
    ]);
    assert.equal(result.status, 0, result.err);
    assert.deepEqual(await approvals(space.approvalsPath), {
      approvals: [
        {
          decision: 'approve',
          market: 'SE',
          service_id: 'spotify',
          plan_id: 'individual',
          billing_period: 'month',
          price_local: '149.00',
          currency: 'SEK',
          source: scraper,
          actor: 'Founder',
          decided_at: decidedAt,
        },
      ],
    });
    assert.match(
      result.out,
      /approved 149\.00 SEK \(scraper:youfundceo\.com\) for SE\/spotify\/individual\/month, which was conflict/,
    );
    assert.match(result.out, /the manual override says 159\.00 SEK/);
  } finally {
    await space.dispose();
  }
});

test('review reject on a ±40% flag appends a rejection, after every earlier entry unchanged', async () => {
  const space = await workspace();
  try {
    assert.equal(
      (
        await space.review([
          'approve',
          ...flags('SE', 'spotify', 'individual', 'Founder'),
        ])
      ).status,
      0,
    );
    const before = await approvals(space.approvalsPath);
    const result = await space.review([
      'reject',
      ...flags('SE', 'netflix', 'standard', 'Founder'),
    ]);
    assert.equal(result.status, 0, result.err);
    const after = await approvals(space.approvalsPath);
    assert.equal(after.approvals.length, 2);
    assert.deepEqual(after.approvals[0], before.approvals[0]);
    assert.deepEqual(after.approvals[1], {
      ...before.approvals[0],
      decision: 'reject',
      service_id: 'netflix',
      plan_id: 'standard',
      price_local: '199.00',
    });

    const text = await readFile(space.approvalsPath, 'utf8');
    assert.equal(text, serialiseApprovals(after));
    const options =
      (await prettier.resolveConfig(
        join(projectRoot, 'data/price-index/approvals.json'),
      )) ?? {};
    assert.equal(
      await prettier.check(text, {
        ...options,
        filepath: 'data/price-index/approvals.json',
      }),
      true,
    );
  } finally {
    await space.dispose();
  }
});

test('review approve on a disappearance binds to no price', async () => {
  const space = await workspace();
  try {
    const result = await space.review([
      'approve',
      ...flags('DE', 'spotify', 'individual', 'Founder'),
    ]);
    assert.equal(result.status, 0, result.err);
    const [entry] = (await approvals(space.approvalsPath)).approvals;
    assert.equal(entry!.price_local, null);
    assert.equal(entry!.currency, null);
    assert.equal(entry!.source, scraper);
  } finally {
    await space.dispose();
  }
});

async function assertRefusedUnwritten(
  space: Workspace,
  args: string[],
  pattern: RegExp,
  status = 1,
) {
  const before = await readFile(space.approvalsPath);
  const listing = await readdir(join(space.root, 'data/price-index'));
  const result = await space.review(args);
  assert.equal(result.status, status, `${args.join(' ')}: ${result.err}`);
  assert.match(result.err, pattern);
  assert.equal(result.out, '');
  assert.deepEqual(await readFile(space.approvalsPath), before);
  assert.deepEqual(
    await readdir(join(space.root, 'data/price-index')),
    listing,
  );
}

test('a decision without --actor, or with an empty one, is refused before anything is written', async () => {
  const space = await workspace();
  try {
    for (const decisionWord of ['approve', 'reject']) {
      await assertRefusedUnwritten(
        space,
        [decisionWord, ...flags('SE', 'spotify', 'individual')],
        /needs --actor/,
      );
      await assertRefusedUnwritten(
        space,
        [decisionWord, ...flags('SE', 'spotify', 'individual', '   ')],
        /needs --actor/,
      );
    }
  } finally {
    await space.dispose();
  }
});

test('the command takes exactly its four flags', async () => {
  const space = await workspace();
  try {
    const cases: [string[], RegExp][] = [
      [
        [
          'approve',
          ...flags('SE', 'spotify', 'individual', 'Founder'),
          '--source',
          scraper,
        ],
        /--source is not a flag of review/,
      ],
      [
        [
          'approve',
          ...flags('SE', 'spotify', 'individual', 'Founder'),
          '--market',
          'SE',
        ],
        /--market is given twice/,
      ],
      [
        [
          'approve',
          '--market',
          'SE',
          '--service',
          'spotify',
          '--actor',
          'Founder',
        ],
        /--plan is required/,
      ],
      [
        ['approve', '--market', '--service', 'spotify'],
        /--market needs a value/,
      ],
      [
        ['accept', ...flags('SE', 'spotify', 'individual', 'Founder')],
        /approve or reject/,
      ],
    ];
    for (const [args, pattern] of cases) {
      await assertRefusedUnwritten(space, args, pattern);
    }
  } finally {
    await space.dispose();
  }
});

test('only a needs_review or conflict record takes a decision', async () => {
  const space = await workspace();
  try {
    await assertRefusedUnwritten(
      space,
      ['approve', ...flags('US', 'spotify', 'individual', 'Founder')],
      /is ok; only needs_review and conflict records take a decision/,
    );
    await assertRefusedUnwritten(
      space,
      ['approve', ...flags('GB', 'spotify', 'individual', 'Founder')],
      /latest\.json has no record for GB\/spotify\/individual\/month/,
    );
  } finally {
    await space.dispose();
  }
});

test('a value that breaks the currency or price check can never be approved or rejected', async () => {
  const space = await workspace();
  try {
    for (const word of ['approve', 'reject']) {
      await assertRefusedUnwritten(
        space,
        [word, ...flags('SE', 'netflix', 'basic', 'Founder')],
        /breaks the currency check/,
      );
      await assertRefusedUnwritten(
        space,
        [word, ...flags('SE', 'netflix', 'premium', 'Founder')],
        /breaks the price check/,
      );
    }
  } finally {
    await space.dispose();
  }
});

test('an unknown market, service or plan, or a disabled market, is refused', async () => {
  const space = await workspace();
  try {
    await assertRefusedUnwritten(
      space,
      ['approve', ...flags('XX', 'spotify', 'individual', 'Founder')],
      /XX is not a market/,
    );
    await assertRefusedUnwritten(
      space,
      ['approve', ...flags('SE', 'tidal', 'individual', 'Founder')],
      /tidal is not a service/,
    );
    await assertRefusedUnwritten(
      space,
      ['approve', ...flags('SE', 'spotify', 'family', 'Founder')],
      /family is not a plan of spotify/,
    );

    const marketsPath = join(space.root, 'config/markets.json');
    const markets = marketsFileSchema.parse(
      JSON.parse(await readFile(marketsPath, 'utf8')),
    );
    markets.markets.find((market) => market.code === 'SE')!.enabled = false;
    await writeFile(marketsPath, JSON.stringify(markets));
    await assertRefusedUnwritten(
      space,
      ['approve', ...flags('SE', 'spotify', 'individual', 'Founder')],
      /SE is disabled/,
    );
  } finally {
    await space.dispose();
  }
});

test('with no latest.json there is nothing to review', async () => {
  const space = await workspace({ latest: null });
  try {
    await assertRefusedUnwritten(
      space,
      ['approve', ...flags('SE', 'spotify', 'individual', 'Founder')],
      /no data\/price-index\/latest\.json yet/,
    );
  } finally {
    await space.dispose();
  }
});

test('an invalid approvals.json or configuration stops the command with exit code 3, writing nothing', async () => {
  const space = await workspace();
  try {
    await writeFile(
      space.approvalsPath,
      JSON.stringify({ approvals: [{ ...decision(), actor: '' }] }),
    );
    await assertRefusedUnwritten(
      space,
      ['approve', ...flags('SE', 'spotify', 'individual', 'Founder')],
      /approvals\.json is invalid/,
      3,
    );
    await writeFile(space.approvalsPath, '{ "approvals": [] }\n');
    await writeFile(join(space.root, 'config/catalogue.json'), '{');
    await assertRefusedUnwritten(
      space,
      ['approve', ...flags('SE', 'spotify', 'individual', 'Founder')],
      /configuration is invalid/,
      3,
    );
  } finally {
    await space.dispose();
  }
});

test('appendApproval refuses an entry without an actor and leaves the file as it was', async () => {
  const space = await workspace();
  try {
    const before = await readFile(space.approvalsPath);
    await assert.rejects(
      appendApproval(space.approvalsPath, decision({ actor: '' })),
      /the decision is invalid/,
    );
    assert.deepEqual(await readFile(space.approvalsPath), before);
  } finally {
    await space.dispose();
  }
});

test('a recorded approval is what the next merge applies, and only to that value', async () => {
  const space = await workspace();
  try {
    await space.review([
      'approve',
      ...flags('SE', 'spotify', 'individual', 'Founder'),
    ]);
    const recorded = await approvals(space.approvalsPath);
    const catalogue = catalogueFileSchema.parse(
      JSON.parse(
        await readFile(join(space.root, 'config/catalogue.json'), 'utf8'),
      ),
    );
    const markets = marketsFileSchema.parse(
      JSON.parse(
        await readFile(join(space.root, 'config/markets.json'), 'utf8'),
      ),
    );
    const previous = await createJsonFileStore({
      directory: join(space.root, 'data/price-index'),
    }).readLatest();
    const merge = (price: string) =>
      mergePriceIndex({
        previous,
        run: run({ observations: [observation({ price_local: price })] }),
        overrides: { overrides: [priceOverride({ price_local: '159.00' })] },
        approvals: recorded,
        catalogue,
        markets,
        settings: settings(),
        clock: clockAt('2026-12-01T11:00:00.000Z'),
      }).records.find(
        (entry) =>
          entry.market === 'SE' &&
          entry.service_id === 'spotify' &&
          entry.plan_id === 'individual',
      )!;
    assert.equal(merge('149.00').status, 'ok');
    assert.equal(merge('155.00').status, 'conflict');
  } finally {
    await space.dispose();
  }
});

test('parseReviewArguments reads exactly the documented flags', () => {
  assert.deepEqual(
    parseReviewArguments([
      'reject',
      ...flags('se', 'spotify', 'individual', ' Founder '),
    ]),
    {
      decision: 'reject',
      market: 'SE',
      service: 'spotify',
      plan: 'individual',
      actor: 'Founder',
    },
  );
});

test('the usage text names the review command', async () => {
  const err: string[] = [];
  const status = await runCli(['help'], {
    root: projectRoot,
    stdout: () => undefined,
    stderr: (text) => err.push(text),
  });
  assert.equal(status, 1);
  assert.match(
    err.join(''),
    /review approve\|reject --market <code> --service <service_id>/,
  );
});
