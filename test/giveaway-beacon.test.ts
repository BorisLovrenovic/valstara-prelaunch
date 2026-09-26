import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { ChainInfo, RandomnessBeacon } from 'drand-client';
import fc from 'fast-check';

import type { DrandConfiguration } from '../src/server/config.ts';
import {
  BeaconUnavailableError,
  deriveDrawSeed,
  fetchVerifiedBeacon,
  readChainInfo,
  targetFutureRound,
  targetRoundAlreadyExists,
  verifyRecordedBeacon,
} from '../src/server/giveaway/beacon.ts';
import { entrySelectionScore } from '../src/server/giveaway/draw.ts';
import { currentDrawRulesFromFiles } from '../src/server/giveaway/current-draw-rules.ts';

// Recorded from the public quicknet chain, round 101. Tests never contact a relay.
const chainInfo: ChainInfo = {
  public_key:
    '83cf0f2896adee7eb8b5f01fcad3912212c437e0073e911fb90022d3e760183c8c4b450b6a0a6c3ac6a5776a2d1064510d1fec758c921cc22b0e17e63aaf4bcb5ed66304de9cf809bd274ca73bab4af5a6e9c76a4bc09e76eae8991ef5ece45a',
  period: 3,
  genesis_time: 1692803367,
  hash: '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',
  groupHash: 'f477d5c89f21a17c863a7f937c6a6d15859414d2be09cd448d4279af331c5d3e',
  schemeID: 'bls-unchained-g1-rfc9380',
  metadata: { beaconID: 'quicknet' },
};
const beacon: RandomnessBeacon = {
  round: 101,
  randomness:
    '966d0eee13f38469fa8a5f8d06f1d9c4cc65c96d18730510109b681f4c0296f0',
  signature:
    '8e4812d08192220e1f7822bae97d7a2f196c73c421927c28d39257b3792b986674e4395323c78dc2a93041e3fc1eaa22',
};
const configuration: DrandConfiguration = {
  chainHash: chainInfo.hash,
  publicKey: chainInfo.public_key,
  relays: ['https://relay-one.test', 'https://relay-two.test'],
};

function relayFetch(
  responses: {
    first?: RandomnessBeacon;
    second?: RandomnessBeacon;
    outage?: boolean;
  } = {},
): typeof fetch {
  return async (input) => {
    const url = String(input);
    if (responses.outage && url.includes('relay-two'))
      throw new Error('relay unavailable');
    if (url.endsWith('/info')) return Response.json(chainInfo);
    if (url.endsWith('/public/latest')) {
      return Response.json({ ...beacon, round: 100 });
    }
    return Response.json(
      url.includes('relay-one')
        ? (responses.first ?? beacon)
        : (responses.second ?? beacon),
    );
  };
}

test('the committed target is the first drand round at least five minutes in the future', async () => {
  const commit = new Date(chainInfo.genesis_time * 1000);
  const target = targetFutureRound(commit, chainInfo);
  assert.equal(target.round, 101);
  assert.equal(target.scheduledAt.getTime() - commit.getTime(), 300_000);
  assert.equal(
    await targetRoundAlreadyExists(configuration, target.round, relayFetch()),
    false,
  );
  const alreadyPublished: typeof fetch = async (input) =>
    Response.json(
      String(input).endsWith('/public/latest') ? beacon : chainInfo,
    );
  assert.equal(
    await targetRoundAlreadyExists(
      configuration,
      target.round,
      alreadyPublished,
    ),
    true,
  );
});

test('the recorded real round verifies offline and derives the exact byte-level seed', async () => {
  const snapshotHash = Buffer.from(
    '8d8d0572b42f193c291c94350d24e3c1354dbdc322fdd808e912bf8b54f00afd',
    'hex',
  );
  assert.equal(
    await verifyRecordedBeacon(chainInfo, beacon, 101, configuration),
    true,
  );
  assert.equal(
    deriveDrawSeed(snapshotHash, 101, beacon.randomness),
    'ddefbb726014b7cced1d8603690b878878e3550c0b8e99daf4ade2ed518e34b6',
  );
  assert.equal(
    await verifyRecordedBeacon(
      chainInfo,
      {
        ...beacon,
        signature: `00${beacon.signature.slice(2)}`,
      },
      101,
      configuration,
    ),
    false,
  );
  assert.equal(
    await verifyRecordedBeacon(chainInfo, beacon, 102, configuration),
    false,
  );
});

test('seeded property: seed derivation matches the recorded-byte formula', () => {
  fc.assert(
    fc.property(
      fc.uint8Array({ minLength: 32, maxLength: 32 }),
      fc.integer({ min: 1, max: 1_000_000 }),
      fc.uint8Array({ minLength: 32, maxLength: 32 }),
      (snapshot, round, randomness) => {
        const roundBytes = Buffer.alloc(8);
        roundBytes.writeBigUInt64BE(BigInt(round));
        const expected = createHash('sha256')
          .update(Buffer.from(snapshot))
          .update(roundBytes)
          .update(Buffer.from(randomness))
          .digest('hex');
        assert.equal(
          deriveDrawSeed(
            Buffer.from(snapshot),
            round,
            Buffer.from(randomness).toString('hex'),
          ),
          expected,
        );
      },
    ),
    { seed: 70_505, numRuns: 100 },
  );
});

test('two relays must agree on a signature-verified round; an outage supplies no fallback', async () => {
  assert.deepEqual(await readChainInfo(configuration, relayFetch()), chainInfo);
  const verified = await fetchVerifiedBeacon(
    configuration,
    chainInfo,
    101,
    relayFetch(),
  );
  assert.deepEqual(verified.verifiedRelays, configuration.relays);
  assert.equal(verified.beacon.randomness, beacon.randomness);
  await assert.rejects(
    fetchVerifiedBeacon(
      configuration,
      chainInfo,
      101,
      relayFetch({ outage: true }),
    ),
    BeaconUnavailableError,
  );
  await assert.rejects(
    fetchVerifiedBeacon(
      configuration,
      chainInfo,
      101,
      relayFetch({
        second: { ...beacon, signature: `00${beacon.signature.slice(2)}` },
      }),
    ),
    BeaconUnavailableError,
  );
});

test('equal ledger rows have equal draw weight, independent of base or referral label', () => {
  const trials = 8_000;
  let firstForThree = 0;
  for (let index = 0; index < trials; index += 1) {
    const seed = Buffer.from(
      index.toString(16).padStart(64, '0'),
      'hex',
    ).toString('hex');
    const three = ['a-base', 'a-referral-1', 'a-referral-2'].map((id) =>
      entrySelectionScore(seed, id),
    );
    const one = entrySelectionScore(seed, 'b-base');
    if (Math.min(...three) < one) firstForThree += 1;
  }
  const proportion = firstForThree / trials;
  assert.ok(proportion > 0.72 && proportion < 0.78, `observed ${proportion}`);
});

test('the current published revision cannot start a draw while its bundle is unannounced', async () => {
  const current = await currentDrawRulesFromFiles();
  assert.equal(current.bundleContentsListed, false);
  assert.equal(current.prizeCount, 5);

  const directory = await mkdtemp(join(tmpdir(), 'valstara-draw-rules-'));
  try {
    const version = 'VAL-GW-LAUNCH-20270401-r2';
    await writeFile(
      join(directory, `${version}.md`),
      `---\nrulesVersion: ${version}\n` +
        `sha256: '${'ab'.repeat(32)}'\nprizeCount: 5\nbundleContents:\n` +
        `  - Product A\n  - Product B\n---\n`,
    );
    assert.equal(
      (await currentDrawRulesFromFiles(directory)).bundleContentsListed,
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
