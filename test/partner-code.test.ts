import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test, { after, before } from 'node:test';

import { runMigrations } from '../src/server/db/migration.ts';
import { createPool, type DatabasePool } from '../src/server/db/pool.ts';
import {
  blockedPartnerCodeCategory,
  createPartnerCodeRules,
  normalisePartnerCode,
  parsePartnerCodeBlocklist,
  partnerCodeBlocklist,
  type PartnerCodeCheck,
  type PartnerCodeRules,
} from '../src/server/referral/partner-code.ts';

// E11.7-01: the partner code rules — format, blocklist, availability against
// the shared registry, and alternatives.

const defaultDatabaseUrl =
  'postgresql://valstara:valstara-local-only@127.0.0.1:5434/postgres';
const applicationRolePassword =
  process.env.VALSTARA_APP_DB_PASSWORD ?? 'valstara-app-local-only';

let admin: DatabasePool;
let owner: DatabasePool;
let app: DatabasePool;
let databaseName: string;

before(async () => {
  databaseName = `valstara_e11701p_${randomUUID().replaceAll('-', '')}`;
  const adminUrl = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  admin = createPool(adminUrl.toString());
  await admin.execute({ text: `CREATE DATABASE "${databaseName}"` });
  owner = createPool(databaseUrl.toString());
  await runMigrations(owner, {
    applicationRolePassword,
    release: 'e11-7-01-partner-code-test',
  });
  const appUrl = new URL(databaseUrl);
  appUrl.username = 'valstara_app';
  appUrl.password = applicationRolePassword;
  app = createPool(appUrl.toString());
});

after(async () => {
  await app?.close();
  await owner?.close();
  if (admin !== undefined) {
    await admin.execute({
      text: `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
    });
    await admin.close();
  }
});

async function registerPartnerCode(code: string): Promise<void> {
  await owner.execute({
    text: `INSERT INTO referral_code (code, owner_kind, owner_id) VALUES ($1, 'partner', $2)`,
    values: [code, randomUUID()],
  });
}

async function registerMemberCode(code: string): Promise<void> {
  const id = randomUUID();
  await owner.execute({
    text: `
      INSERT INTO subscriber (
        id, email, email_normalised, email_domain, status, verified_at, referral_code
      )
      VALUES ($1, $2, $2, 'example.test', 'verified', '2026-11-01T09:00:00Z', $3)
    `,
    values: [id, `${id}@example.test`, code],
  });
}

function refusal(result: PartnerCodeCheck) {
  assert.equal(result.outcome, 'refused');
  if (result.outcome !== 'refused') {
    throw new Error('unreachable');
  }
  return result;
}

/** Each alternative must itself be accepted by every rule, as submitted. */
async function assertAlternativesValid(
  rules: PartnerCodeRules,
  result: PartnerCodeCheck,
  label: string,
): Promise<void> {
  const refused = refusal(result);
  assert.ok(refused.alternatives.length <= 3, label);
  assert.equal(
    new Set(refused.alternatives).size,
    refused.alternatives.length,
    `${label}: alternatives repeat`,
  );
  for (const alternative of refused.alternatives) {
    assert.match(alternative, /^[A-Z0-9]{4,16}$/u, label);
    assert.deepEqual(
      await rules.check(alternative),
      { code: alternative, outcome: 'available' },
      `${label}: ${alternative}`,
    );
    assert.deepEqual(
      await rules.check(alternative.toLowerCase()),
      { code: alternative, outcome: 'available' },
      `${label}: ${alternative} lower case`,
    );
  }
}

test('the format is 4-16 of A-Z and 0-9, case-insensitive, stored upper case', () => {
  const accepted: readonly [string, string][] = [
    ['MAYA', 'MAYA'],
    ['maya', 'MAYA'],
    ['MaYa2026', 'MAYA2026'],
    ['1234', '1234'],
    ['ABCDEFGHIJKLMNOP', 'ABCDEFGHIJKLMNOP'],
    ['abcdefghijklmnop', 'ABCDEFGHIJKLMNOP'],
    ['  maya  ', 'MAYA'],
    ['O0I1L', 'O0I1L'],
  ];
  for (const [input, stored] of accepted) {
    assert.equal(normalisePartnerCode(input), stored, input);
  }

  const refused = [
    '',
    'MAY',
    'ab1',
    'ABCDEFGHIJKLMNOPQ',
    'MAYA-1',
    'MAYA_1',
    'MAYA 1',
    'MAYA.',
    'MAYÄ',
    'ＭＡＹＡ',
    'straße',
    'MAYA\n1',
    '🙂MAYA',
  ];
  for (const input of refused) {
    assert.equal(normalisePartnerCode(input), null, JSON.stringify(input));
  }
});

test('blocklist entries match regardless of case, by contained or exact term', async () => {
  const rules = createPartnerCodeRules(app);
  const blocked: readonly [string, string][] = [
    ['VALSTARA', 'brand'],
    ['valstara', 'brand'],
    ['Valstara1', 'brand'],
    ['myValStArA', 'brand'],
    ['NETFLIX', 'brand'],
    ['netflixdeals', 'brand'],
    ['SpotifyFan', 'brand'],
    ['chatgpt4u', 'brand'],
    ['3nity', 'brand'],
    ['Notion', 'brand'],
    ['admin', 'reserved'],
    ['ADMIN', 'reserved'],
    ['Free', 'reserved'],
    ['support', 'reserved'],
    ['fuck', 'profanity'],
    ['xxFuCkxx', 'profanity'],
    ['ShitPost', 'profanity'],
    ['nazi', 'profanity'],
    ['Rape', 'profanity'],
  ];
  for (const [input, category] of blocked) {
    const stored = normalisePartnerCode(input);
    assert.ok(stored, input);
    assert.equal(blockedPartnerCodeCategory(stored), category, input);
    assert.equal(refusal(await rules.check(input)).reason, 'blocked', input);
  }

  // Exact terms refuse only the whole code, so ordinary names that contain
  // them stay available.
  for (const input of [
    'PROMOTION',
    'EMOTION22',
    'GRAPEJUICE',
    'ARSENAL',
    'BADMINTON',
    'FREEDOM',
    'CANVASART',
    'NORTONSMITH',
  ]) {
    assert.equal(blockedPartnerCodeCategory(input), null, input);
    assert.deepEqual(await rules.check(input.toLowerCase()), {
      code: input,
      outcome: 'available',
    });
  }
});

test('every provider in the showcase is on the brand blocklist', async () => {
  const providers = JSON.parse(
    await readFile('src/content/provider-showcase.json', 'utf8'),
  ) as readonly { readonly name: string }[];
  assert.ok(providers.length > 0);
  const document = JSON.parse(
    await readFile('config/partner-code-blocklist.json', 'utf8'),
  ) as { brand: { contains: string[]; exact: string[] } };
  const brandTerms = new Set([
    ...document.brand.contains,
    ...document.brand.exact,
  ]);
  for (const { name } of providers) {
    const term = name.replace(/[^A-Za-z0-9]/gu, '').toUpperCase();
    assert.ok(brandTerms.has(term), `${name} (${term}) is not blocklisted`);
    if (term.length >= 4 && term.length <= 16) {
      assert.equal(blockedPartnerCodeCategory(term), 'brand', name);
      assert.equal(
        blockedPartnerCodeCategory(
          normalisePartnerCode(term.toLowerCase()) ?? '',
        ),
        'brand',
        `${name} lower case`,
      );
    }
  }
  for (const brand of ['VALSTARA', 'NETFLIX', 'SPOTIFY', 'CHATGPT']) {
    assert.ok(brandTerms.has(brand), brand);
  }
});

test('a malformed blocklist fails at load', () => {
  const valid = {
    about: 'test',
    brand: { contains: ['VALSTARA'], exact: [] },
    profanity: { contains: [], exact: [] },
    reserved: { contains: [], exact: ['ADMIN'] },
  };
  assert.doesNotThrow(() => parsePartnerCodeBlocklist(valid));
  for (const broken of [
    { ...valid, brand: { contains: ['valstara'], exact: [] } },
    { ...valid, reserved: { contains: [], exact: ['API'] } },
    { ...valid, reserved: { contains: [], exact: ['ADMIN-1'] } },
    { ...valid, brand: { contains: ['V'], exact: [] } },
    { ...valid, extra: true },
    { about: 'test', brand: valid.brand, reserved: valid.reserved },
  ]) {
    assert.throws(() => parsePartnerCodeBlocklist(broken));
  }
  assert.equal(partnerCodeBlocklist.categories.length, 3);
});

test('format, blocklist and availability refuse with distinct reasons, in that order', async () => {
  const rules = createPartnerCodeRules(app);
  await registerPartnerCode('TAKENCODE');
  await registerMemberCode('MEMBERCODE23');

  assert.deepEqual(await rules.check('fresh2026'), {
    code: 'FRESH2026',
    outcome: 'available',
  });
  assert.equal(refusal(await rules.check('no')).reason, 'format');
  assert.equal(refusal(await rules.check('NETFLIX!')).reason, 'format');
  assert.equal(refusal(await rules.check('netflix')).reason, 'blocked');
  assert.equal(refusal(await rules.check('takencode')).reason, 'taken');
  assert.equal(refusal(await rules.check('TakenCode')).reason, 'taken');
  assert.equal(refusal(await rules.check('membercode23')).reason, 'taken');

  // A blocklisted code that is also registered is refused as blocked.
  await registerPartnerCode('ADMIN');
  assert.equal(refusal(await rules.check('admin')).reason, 'blocked');
});

test('alternatives are always available codes that pass every rule', async () => {
  // Occupy the obvious suffixes so alternatives must look further.
  for (const code of ['MAYA', 'MAYA1', 'MAYA2', 'MAYA3', 'MAYA5']) {
    await registerPartnerCode(code);
  }
  await registerMemberCode('MAYA4');
  await registerPartnerCode('LONGCODE2026ABCD');
  let randomCalls = 0;
  const rules = createPartnerCodeRules(app, {
    // Deterministic fallback; the first candidates are blocked or taken.
    randomCandidate: () => {
      randomCalls += 1;
      return [
        'FUCK2345',
        'MAYA',
        'ADMIN',
        `RND${String(randomCalls).padStart(5, '0')}`,
      ][randomCalls % 4]!;
    },
  });

  const taken = refusal(await rules.check('maya'));
  assert.equal(taken.reason, 'taken');
  assert.deepEqual(taken.alternatives, ['MAYA6', 'MAYA7', 'MAYA8']);

  const cases = [
    'maya',
    'Maya1',
    'MAYA-2026',
    'a',
    'ab',
    '',
    '!!!!',
    'x'.repeat(40),
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    'netflix',
    'NetflixMaya',
    'mayanetflix',
    'fuck',
    'fuckfuckfuck',
    'FUFUCKCK',
    'admin',
    'free',
    'shitpost',
    'VALSTARA2026',
    'maya4',
    'longcode2026abcd',
    'ÄÖÜÄÖÜ',
  ];
  for (const input of cases) {
    const result = await rules.check(input);
    await assertAlternativesValid(rules, result, JSON.stringify(input));
    assert.equal(
      refusal(result).alternatives.length,
      3,
      `${JSON.stringify(input)} offers three alternatives`,
    );
  }

  // Derived alternatives keep the person's own word where they can.
  assert.deepEqual(refusal(await rules.check('NetflixMaya')).alternatives, [
    'MAYA6',
    'MAYA7',
    'MAYA8',
  ]);
  assert.deepEqual(refusal(await rules.check('admin')).alternatives, [
    'ADMIN1',
    'ADMIN2',
    'ADMIN3',
  ]);
  assert.deepEqual(refusal(await rules.check('MAYA-2026')).alternatives, [
    'MAYA2026',
    'MAYA20261',
    'MAYA20262',
  ]);
  // A 16-character stem is shortened to make room for its suffix.
  assert.deepEqual(
    refusal(await rules.check('longcode2026abcd')).alternatives,
    ['LONGCODE2026ABC1', 'LONGCODE2026ABC2', 'LONGCODE2026ABC3'],
  );
  // With nothing usable in the request, the alternatives are random codes.
  const random = refusal(await rules.check('!!!!')).alternatives;
  assert.equal(random.length, 3);
  for (const alternative of random) {
    assert.match(alternative, /^RND\d{5}$/u);
  }
});
