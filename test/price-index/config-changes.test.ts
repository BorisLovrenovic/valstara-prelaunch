import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runCli } from '../../packages/price-index/src/cli/main.ts';

// E11.6-02, epic rule 5: a catalogue or market change is data, not code.
// Each fixture adds or removes a service, a plan or a market in a copy of the
// committed configuration, and `price-index validate` accepts it unchanged.

const configDirectory = fileURLToPath(new URL('../../config', import.meta.url));
const dataDirectory = fileURLToPath(
  new URL('../../data/price-index', import.meta.url),
);

type Json = Record<string, unknown> & {
  markets?: Json[];
  services?: Json[];
  plans?: Json[];
  source_aliases?: { service: string[]; plans: Record<string, string[]> };
};

async function withConfig(
  change: (files: { markets: Json; catalogue: Json; prices: Json }) => void,
) {
  const root = await mkdtemp(join(tmpdir(), 'valstara-price-index-config-'));
  try {
    await cp(configDirectory, join(root, 'config'), { recursive: true });
    // validate also checks the data files (E11.6-07): the committed seeds.
    await cp(dataDirectory, join(root, 'data/price-index'), {
      recursive: true,
    });
    const path = (name: string) => join(root, 'config', name);
    const files = {
      markets: JSON.parse(await readFile(path('markets.json'), 'utf8')),
      catalogue: JSON.parse(await readFile(path('catalogue.json'), 'utf8')),
      prices: JSON.parse(await readFile(path('valstara-prices.json'), 'utf8')),
    };
    change(files);
    await writeFile(path('markets.json'), JSON.stringify(files.markets));
    await writeFile(path('catalogue.json'), JSON.stringify(files.catalogue));
    await writeFile(path('valstara-prices.json'), JSON.stringify(files.prices));

    const output: string[] = [];
    const status = await runCli(['validate'], {
      root,
      stdout: (text) => output.push(text),
      stderr: (text) => output.push(text),
    });
    return { output: output.join(''), status };
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}

function service(catalogue: Json, id: string): Json {
  const found = catalogue.services!.find((entry) => entry.service_id === id);
  assert.ok(found, id);
  return found;
}

const tidal: Json = {
  service_id: 'tidal',
  name: 'Tidal',
  category: 'music',
  website_url: 'https://tidal.com/',
  status: 'planned',
  plans: [
    {
      plan_id: 'individual',
      name: 'Individual',
      billing_period: 'month',
      is_student: false,
      is_family: false,
    },
  ],
  source_aliases: { service: [], plans: {} },
};

test('the unchanged committed configuration validates', async () => {
  const result = await withConfig(() => {});
  assert.equal(result.status, 0, result.output);
});

test('adding a service passes validate with no code change', async () => {
  const result = await withConfig(({ catalogue }) => {
    catalogue.services!.push(tidal);
  });
  assert.equal(result.status, 0, result.output);
});

test('removing a service passes validate with no code change', async () => {
  const result = await withConfig(({ catalogue }) => {
    catalogue.services = catalogue.services!.filter(
      (entry) => entry.service_id !== 'netflix',
    );
  });
  assert.equal(result.status, 0, result.output);
});

test('adding a plan, with its alias, passes validate with no code change', async () => {
  const result = await withConfig(({ catalogue }) => {
    const spotify = service(catalogue, 'spotify');
    spotify.plans!.push({
      plan_id: 'duo',
      name: 'Duo',
      billing_period: 'month',
      is_student: false,
      is_family: false,
    });
    spotify.source_aliases!.plans.duo = ['Premium Duo'];
  });
  assert.equal(result.status, 0, result.output);
});

test('removing a plan, with its alias, passes validate with no code change', async () => {
  const result = await withConfig(({ catalogue }) => {
    const netflix = service(catalogue, 'netflix');
    netflix.plans = netflix.plans!.filter((plan) => plan.plan_id !== 'basic');
    delete netflix.source_aliases!.plans.basic;
  });
  assert.equal(result.status, 0, result.output);
});

test('adding a market passes validate with no code change', async () => {
  const result = await withConfig(({ markets }) => {
    markets.markets!.push({
      code: 'NZ',
      name: 'New Zealand',
      slug: 'new-zealand',
      currency: 'NZD',
      enabled: false,
    });
  });
  assert.equal(result.status, 0, result.output);
});

test('removing a market passes validate with no code change', async () => {
  const result = await withConfig(({ markets }) => {
    markets.markets = markets.markets!.filter((market) => market.code !== 'SE');
  });
  assert.equal(result.status, 0, result.output);
});

test('a Valstara price follows an added market and service, and fails once they are removed', async () => {
  const entry = {
    service_id: 'tidal',
    plan_id: 'individual',
    market: 'NZ',
    term_months: 12,
    price_local: '199.00',
    currency: 'NZD',
  };
  const added = await withConfig(({ markets, catalogue, prices }) => {
    markets.markets!.push({
      code: 'NZ',
      name: 'New Zealand',
      slug: 'new-zealand',
      currency: 'NZD',
      enabled: true,
    });
    catalogue.services!.push(tidal);
    (prices.prices as unknown[]).push(entry);
  });
  assert.equal(added.status, 0, added.output);

  const orphaned = await withConfig(({ prices }) => {
    (prices.prices as unknown[]).push(entry);
  });
  assert.equal(orphaned.status, 3);
  assert.match(orphaned.output, /unknown service tidal/);
  assert.match(orphaned.output, /unknown market NZ/);
});

test('validate reports a missing or malformed file instead of throwing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'valstara-price-index-empty-'));
  try {
    const output: string[] = [];
    const io = {
      root,
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
    };
    assert.equal(await runCli(['validate'], io), 3);
    assert.match(output.join(''), /config\/markets\.json: file not found/);

    await cp(configDirectory, join(root, 'config'), { recursive: true });
    await writeFile(join(root, 'config', 'catalogue.json'), '{"services": [');
    output.length = 0;
    assert.equal(await runCli(['validate'], io), 3);
    assert.match(output.join(''), /config\/catalogue\.json: not valid JSON/);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test('an unknown command prints the usage and exits 1', async () => {
  const output: string[] = [];
  const io = {
    root: configDirectory,
    stdout: (text: string) => output.push(text),
    stderr: (text: string) => output.push(text),
  };
  assert.equal(await runCli([], io), 1);
  assert.equal(await runCli(['unknown-command'], io), 1);
  assert.equal(await runCli(['validate', '--extra'], io), 1);
  assert.match(output.join(''), /Usage: npm run price-index -- <command>/);
});
