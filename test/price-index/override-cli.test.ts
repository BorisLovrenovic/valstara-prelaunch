import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import * as prettier from 'prettier';

import { runCli } from '../../packages/price-index/src/cli/main.ts';
import {
  officialHost,
  sourceUrlProblem,
} from '../../packages/price-index/src/cli/override.ts';
import {
  linePrompt,
  type Prompt,
} from '../../packages/price-index/src/cli/prompt.ts';
import { mergePriceIndex } from '../../packages/price-index/src/pipeline/index.ts';
import {
  catalogueFileSchema,
  manualOverridesFileSchema,
  marketsFileSchema,
} from '../../packages/price-index/src/schema/index.ts';
import { clockAt, run, settings } from '../helpers/price-index-merge.ts';
import {
  priceIndexWorkspace,
  type Workspace,
} from '../helpers/price-index-run.ts';

// E11.6-08: `price-index override add | not-offered | retire`. Each answer is
// one line; the first refused answer stops the command with nothing
// written. `add` and `not-offered` refuse a currency other than the
// market's, a source_url off the service's official host, a price that does
// not parse exactly and an empty verified_by.

const today = '2026-11-18T12:00:00.000Z';
const seedText = '{\n  "overrides": []\n}\n';

/** A prompt answering from a fixed list; null once it runs out. */
function scripted(answers: readonly string[]) {
  const queue = [...answers];
  const questions: string[] = [];
  let closed = 0;
  const prompt: Prompt = {
    async ask(question) {
      questions.push(question);
      return queue.length === 0 ? null : queue.shift()!;
    },
    close() {
      closed += 1;
    },
  };
  return {
    prompt,
    questions,
    closed: () => closed,
    left: () => queue.length,
  };
}

async function override(
  space: Workspace,
  args: readonly string[],
  answers: readonly string[] | Prompt,
) {
  let out = '';
  let err = '';
  const script = Array.isArray(answers)
    ? scripted(answers as readonly string[])
    : null;
  const status = await runCli(['override', ...args], {
    root: space.root,
    stdout: (text) => (out += text),
    stderr: (text) => (err += text),
    clock: clockAt(today),
    prompt: script?.prompt ?? (answers as Prompt),
  });
  return { status, out, err, script };
}

const overridesPath = (space: Workspace) =>
  join(space.dataDirectory, 'manual-overrides.json');

async function overridesText(space: Workspace) {
  return readFile(overridesPath(space), 'utf8');
}

async function withSpace(body: (space: Workspace) => Promise<void>) {
  const space = await priceIndexWorkspace({
    services: ['netflix', 'spotify'],
    markets: ['SE', 'US'],
  });
  try {
    await body(space);
  } finally {
    await space.dispose();
  }
}

/** A valid `add` for Spotify in Sweden, with one answer replaced. */
function addAnswers(change: Partial<Record<AddKey, string>> = {}): string[] {
  const answers: Record<AddKey, string> = {
    market: 'SE',
    service: 'spotify',
    plan: 'individual',
    period: '',
    price: '149 kr',
    currency: 'SEK',
    usd: '14.80',
    url: 'https://www.spotify.com/se/premium/',
    verifiedAt: '2026-11-17',
    verifiedBy: 'Founder',
    note: 'Read on the Swedish premium page.',
    ...change,
  };
  return addKeys.map((key) => answers[key]);
}
const addKeys = [
  'market',
  'service',
  'plan',
  'period',
  'price',
  'currency',
  'usd',
  'url',
  'verifiedAt',
  'verifiedBy',
  'note',
] as const;
type AddKey = (typeof addKeys)[number];

/** A valid `not-offered` for Netflix Basic in the United States. */
function notOfferedAnswers(
  change: Partial<Record<NotOfferedKey, string>> = {},
): string[] {
  const answers: Record<NotOfferedKey, string> = {
    market: 'US',
    service: 'netflix',
    plan: 'basic',
    period: 'month',
    url: 'https://www.netflix.com/signup/planform',
    verifiedAt: '',
    verifiedBy: 'Founder',
    note: '',
    ...change,
  };
  return notOfferedKeys.map((key) => answers[key]);
}
const notOfferedKeys = [
  'market',
  'service',
  'plan',
  'period',
  'url',
  'verifiedAt',
  'verifiedBy',
  'note',
] as const;
type NotOfferedKey = (typeof notOfferedKeys)[number];

async function mergedWith(space: Workspace) {
  const read = async (file: string) =>
    JSON.parse(await readFile(join(space.root, file), 'utf8'));
  return mergePriceIndex({
    previous: null,
    run: run(),
    overrides: manualOverridesFileSchema.parse(
      await read('data/price-index/manual-overrides.json'),
    ),
    approvals: { approvals: [] },
    catalogue: catalogueFileSchema.parse(await read('config/catalogue.json')),
    markets: marketsFileSchema.parse(await read('config/markets.json')),
    settings: settings(),
    clock: clockAt(today),
  });
}

test('override add asks each question in order and writes the entry atomically, in the repository format', async () => {
  await withSpace(async (space) => {
    const result = await override(space, ['add'], addAnswers());
    assert.equal(result.status, 0, result.err);
    assert.equal(result.script!.left(), 0);
    assert.equal(result.script!.closed(), 1);
    assert.deepEqual(
      result.script!.questions.map((question) => question.split(' ')[0]),
      [
        'Market',
        'Service',
        'Plan',
        'Billing',
        'Local',
        'Currency',
        'USD',
        'Source',
        'Verified',
        'Verified',
        'Note',
      ],
    );
    const text = await overridesText(space);
    assert.equal(
      text,
      `{
  "overrides": [
    {
      "kind": "price",
      "market": "SE",
      "service_id": "spotify",
      "plan_id": "individual",
      "billing_period": "month",
      "price_local": "149.00",
      "currency": "SEK",
      "price_usd_source": "14.80",
      "source_url": "https://www.spotify.com/se/premium/",
      "verified_at": "2026-11-17",
      "verified_by": "Founder",
      "note": "Read on the Swedish premium page."
    }
  ]
}
`,
    );
    const path = overridesPath(space);
    const options = (await prettier.resolveConfig(path)) ?? {};
    assert.ok(await prettier.check(text, { ...options, filepath: path }));
    assert.match(
      result.out,
      /added SE\/spotify\/individual\/month: 149\.00 SEK/,
    );

    // The next merge publishes it as a manual override.
    const merged = await mergedWith(space);
    const spotify = merged.records.find(
      (record) => record.market === 'SE' && record.service_id === 'spotify',
    )!;
    assert.equal(spotify.status, 'manual_override');
    assert.equal(spotify.price_local, '149.00');
    assert.equal(spotify.source, 'manual');

    // validate accepts the written file.
    let out = '';
    const status = await runCli(['validate'], {
      root: space.root,
      stdout: (chunk) => (out += chunk),
      stderr: (chunk) => (out += chunk),
    });
    assert.equal(status, 0, out);
  });
});

test('override add reads answers piped in all at once, and the optional ones may be left empty', async () => {
  await withSpace(async (space) => {
    const lines = addAnswers({
      market: 'us',
      price: '$12.99',
      currency: '',
      usd: '',
      url: 'https://www.spotify.com/us/premium/',
      note: '',
    });
    const input = Readable.from([`${lines.join('\n')}\n`]);
    let asked = '';
    const result = await override(
      space,
      ['add'],
      linePrompt(input, (text) => (asked += text)),
    );
    assert.equal(result.status, 0, result.err);
    assert.match(asked, /Currency \[USD\]: /);
    const [entry] = manualOverridesFileSchema.parse(
      JSON.parse(await overridesText(space)),
    ).overrides;
    assert.deepEqual(entry, {
      kind: 'price',
      market: 'US',
      service_id: 'spotify',
      plan_id: 'individual',
      billing_period: 'month',
      price_local: '12.99',
      currency: 'USD',
      price_usd_source: null,
      source_url: 'https://www.spotify.com/us/premium/',
      verified_at: '2026-11-17',
      verified_by: 'Founder',
      note: null,
    });
  });
});

test('override not-offered records a confirmed not_offered, which the merge then shows', async () => {
  await withSpace(async (space) => {
    const result = await override(space, ['not-offered'], notOfferedAnswers());
    assert.equal(result.status, 0, result.err);
    const [entry] = manualOverridesFileSchema.parse(
      JSON.parse(await overridesText(space)),
    ).overrides;
    assert.deepEqual(entry, {
      kind: 'not_offered',
      market: 'US',
      service_id: 'netflix',
      plan_id: 'basic',
      billing_period: 'month',
      source_url: 'https://www.netflix.com/signup/planform',
      verified_at: '2026-11-18',
      verified_by: 'Founder',
      note: null,
    });
    const merged = await mergedWith(space);
    const basic = merged.records.find(
      (record) => record.market === 'US' && record.plan_id === 'basic',
    )!;
    assert.equal(basic.status, 'not_offered');
    assert.equal(basic.price_local, null);
  });
});

test('override retire removes the one entry, and leaves the others', async () => {
  await withSpace(async (space) => {
    assert.equal((await override(space, ['add'], addAnswers())).status, 0);
    assert.equal(
      (await override(space, ['not-offered'], notOfferedAnswers())).status,
      0,
    );
    const result = await override(
      space,
      ['retire'],
      ['SE', 'spotify', 'individual', ''],
    );
    assert.equal(result.status, 0, result.err);
    assert.match(
      result.out,
      /retired SE\/spotify\/individual\/month: 149\.00 SEK/,
    );
    const file = manualOverridesFileSchema.parse(
      JSON.parse(await overridesText(space)),
    );
    assert.deepEqual(
      file.overrides.map((entry) => [
        entry.market,
        entry.service_id,
        entry.kind,
      ]),
      [['US', 'netflix', 'not_offered']],
    );
    const again = await override(
      space,
      ['retire'],
      ['US', 'netflix', 'basic', ''],
    );
    assert.equal(again.status, 0, again.err);
    assert.equal(await overridesText(space), seedText);
  });
});

const refusals: [string, string[], string[], RegExp][] = [
  // The four the ticket names.
  [
    "add: a currency other than the market's",
    ['add'],
    addAnswers({ currency: 'EUR' }),
    /EUR is not SE's currency; SE uses SEK/,
  ],
  [
    'add: a source_url on another host',
    ['add'],
    addAnswers({ url: 'https://www.youfundceo.com/services/spotify/sweden' }),
    /not on www\.spotify\.com, the official host of spotify/,
  ],
  [
    'add: a source_url on a look-alike host',
    ['add'],
    addAnswers({ url: 'https://www.spotify.com.example.net/se/' }),
    /not on www\.spotify\.com/,
  ],
  [
    'add: a source_url on another subdomain',
    ['add'],
    addAnswers({ url: 'https://open.spotify.com/premium' }),
    /not on www\.spotify\.com/,
  ],
  [
    'add: a source_url over plain http',
    ['add'],
    addAnswers({ url: 'http://www.spotify.com/se/premium/' }),
    /not an https URL/,
  ],
  [
    'add: a source_url that is not a URL',
    ['add'],
    addAnswers({ url: 'spotify.com/se' }),
    /is not a URL/,
  ],
  [
    'add: a price with more decimals than the currency',
    ['add'],
    addAnswers({ price: '149.9999' }),
    /does not parse exactly in SEK/,
  ],
  [
    "add: a price in another currency's format",
    ['add'],
    addAnswers({ price: '€149' }),
    /does not parse exactly in SEK/,
  ],
  [
    'add: a price that is not a price',
    ['add'],
    addAnswers({ price: 'about 149' }),
    /does not parse exactly in SEK/,
  ],
  [
    'add: a price written with two numbers',
    ['add'],
    addAnswers({ price: '149 or 159' }),
    /does not parse exactly in SEK/,
  ],
  [
    'add: an empty price',
    ['add'],
    addAnswers({ price: '' }),
    /does not parse exactly in SEK/,
  ],
  ['add: a price of zero', ['add'], addAnswers({ price: '0' }), /above zero/],
  [
    'add: an empty verified_by',
    ['add'],
    addAnswers({ verifiedBy: '' }),
    /verified_by is empty/,
  ],
  [
    'add: a blank verified_by',
    ['add'],
    addAnswers({ verifiedBy: '   ' }),
    /verified_by is empty/,
  ],
  [
    'not-offered: a source_url on another host',
    ['not-offered'],
    notOfferedAnswers({ url: 'https://help.netflix.com/en/node/24926' }),
    /not on www\.netflix\.com, the official host of netflix/,
  ],
  [
    'not-offered: an empty verified_by',
    ['not-offered'],
    notOfferedAnswers({ verifiedBy: '' }),
    /verified_by is empty/,
  ],
  // The other answers, checked against the configuration and the schema.
  [
    'add: a USD figure with three decimals',
    ['add'],
    addAnswers({ usd: '14.801' }),
    /USD figure "14\.801" does not parse exactly/,
  ],
  [
    'add: an unknown market',
    ['add'],
    addAnswers({ market: 'XX' }),
    /XX is not a market/,
  ],
  [
    'add: a service not in the catalogue',
    ['add'],
    addAnswers({ service: 'disney-plus' }),
    /disney-plus is not a service/,
  ],
  [
    'add: a plan not in the catalogue',
    ['add'],
    addAnswers({ plan: 'duo' }),
    /duo is not a plan of spotify/,
  ],
  [
    'add: another billing period',
    ['add'],
    addAnswers({ period: 'year' }),
    /tracked per month, not year/,
  ],
  [
    'add: a verified_at in the future',
    ['add'],
    addAnswers({ verifiedAt: '2026-11-19' }),
    /2026-11-19 is in the future/,
  ],
  [
    'add: a verified_at that is not a date',
    ['add'],
    addAnswers({ verifiedAt: '2026-02-30' }),
    /not a calendar date/,
  ],
  [
    'add: input that ends early',
    ['add'],
    addAnswers().slice(0, 7),
    /the input ended before every question was answered/,
  ],
  [
    'not-offered: input that ends early',
    ['not-offered'],
    [],
    /the input ended/,
  ],
  [
    'retire: no entry to retire',
    ['retire'],
    ['SE', 'spotify', 'individual', ''],
    /there is no manual entry for SE\/spotify\/individual\/month/,
  ],
];

for (const [name, args, answers, message] of refusals) {
  test(`override refuses ${name}, and writes nothing`, async () => {
    await withSpace(async (space) => {
      const result = await override(space, args, answers);
      assert.equal(result.status, 1, `${result.out}\n${result.err}`);
      assert.match(result.err, message);
      assert.match(result.err, /Nothing was written\./);
      assert.equal(await overridesText(space), seedText);
      assert.equal(result.script!.closed(), 1, 'the input was not released');
    });
  });
}

test('override refuses a disabled market, and a second entry for one record', async () => {
  await withSpace(async (space) => {
    const disabled = await override(
      space,
      ['add'],
      addAnswers({ market: 'DE' }),
    );
    assert.equal(disabled.status, 1);
    assert.match(disabled.err, /DE is disabled/);

    assert.equal((await override(space, ['add'], addAnswers())).status, 0);
    const before = await overridesText(space);
    const second = await override(
      space,
      ['not-offered'],
      notOfferedAnswers({
        market: 'SE',
        service: 'spotify',
        plan: 'individual',
      }),
    );
    assert.equal(second.status, 1);
    assert.match(
      second.err,
      /already a manual entry for SE\/spotify\/individual\/month .*Retire it first/,
    );
    assert.equal(await overridesText(space), before);
  });
});

test('override refuses an unknown action or a flag before asking anything', async () => {
  await withSpace(async (space) => {
    for (const args of [[], ['remove'], ['add', '--market', 'SE']]) {
      const result = await override(space, args, addAnswers());
      assert.equal(result.status, 1, args.join(' '));
      assert.match(
        result.err,
        /override add, override not-offered or override retire/,
      );
      assert.deepEqual(result.script!.questions, []);
    }
    assert.equal(await overridesText(space), seedText);
  });
});

test('override exits 3 on an invalid manual-overrides.json, and leaves it as it was', async () => {
  await withSpace(async (space) => {
    const broken = '{ "overrides": [{ "kind": "price" }] }\n';
    await writeFile(overridesPath(space), broken);
    const result = await override(space, ['add'], addAnswers());
    assert.equal(result.status, 3);
    assert.match(result.err, /manual-overrides\.json/);
    assert.equal(await overridesText(space), broken);
  });
});

test('the official host is the catalogue website_url host, compared exactly', () => {
  const spotify = {
    service_id: 'spotify',
    website_url: 'https://www.spotify.com/',
  };
  assert.equal(officialHost(spotify), 'www.spotify.com');
  assert.equal(
    sourceUrlProblem('https://www.spotify.com/se/premium/', spotify),
    null,
  );
  assert.equal(sourceUrlProblem('https://WWW.Spotify.com/se/', spotify), null);
  for (const url of [
    'https://spotify.com/se/',
    'https://www.spotify.com.evil.example/',
    'https://evil.example/https://www.spotify.com/',
    'https://www.spotify.com@evil.example/',
  ]) {
    assert.notEqual(sourceUrlProblem(url, spotify), null, url);
  }
});
