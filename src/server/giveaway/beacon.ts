import { createHash } from 'node:crypto';

import {
  fetchBeacon,
  roundAt,
  roundTime,
  type ChainClient,
  type ChainInfo,
  type RandomnessBeacon,
} from 'drand-client';

import type { DrandConfiguration } from '../config.ts';

const minimumFutureMilliseconds = 5 * 60 * 1_000;
const requestTimeoutMilliseconds = 5_000;

export interface VerifiedBeacon {
  readonly beacon: RandomnessBeacon;
  readonly relay: string;
  readonly verifiedRelays: readonly string[];
}

export class BeaconUnavailableError extends Error {
  public constructor() {
    super('Two matching, verified drand relay responses are required.');
    this.name = 'BeaconUnavailableError';
  }
}

export function targetFutureRound(
  committedAt: Date,
  info: ChainInfo,
): {
  round: number;
  scheduledAt: Date;
} {
  const threshold = committedAt.getTime() + minimumFutureMilliseconds;
  const current = roundAt(threshold, info);
  const round = roundTime(info, current) >= threshold ? current : current + 1;
  const scheduledAt = new Date(roundTime(info, round));
  if (
    scheduledAt.getTime() < threshold ||
    round <= roundAt(committedAt.getTime(), info)
  ) {
    throw new Error(
      'The target drand round is not sufficiently in the future.',
    );
  }
  return { round, scheduledAt };
}

export function deriveDrawSeed(
  snapshotHash: Buffer,
  round: number,
  randomness: string,
): string {
  if (
    snapshotHash.length !== 32 ||
    !Number.isSafeInteger(round) ||
    round < 1 ||
    !/^[a-f0-9]{64}$/u.test(randomness)
  ) {
    throw new RangeError('Invalid draw seed material.');
  }
  const roundBytes = Buffer.alloc(8);
  roundBytes.writeBigUInt64BE(BigInt(round));
  return createHash('sha256')
    .update(snapshotHash)
    .update(roundBytes)
    .update(Buffer.from(randomness, 'hex'))
    .digest('hex');
}

export function assertChainInfo(
  info: ChainInfo,
  config: DrandConfiguration,
): void {
  if (
    info.hash !== config.chainHash ||
    info.public_key !== config.publicKey ||
    !Number.isSafeInteger(info.genesis_time) ||
    info.genesis_time <= 0 ||
    !Number.isSafeInteger(info.period) ||
    info.period <= 0 ||
    typeof info.schemeID !== 'string' ||
    info.schemeID.length === 0
  ) {
    throw new BeaconUnavailableError();
  }
}

function chainPath(config: DrandConfiguration, relay: string): string {
  return `${relay.replace(/\/$/u, '')}/${config.chainHash}`;
}

async function readJson(url: string, request: typeof fetch): Promise<unknown> {
  const response = await request(url, {
    signal: AbortSignal.timeout(requestTimeoutMilliseconds),
  });
  if (!response.ok) throw new BeaconUnavailableError();
  return response.json();
}

function asBeacon(raw: unknown): RandomnessBeacon {
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('round' in raw) ||
    !Number.isSafeInteger(raw.round) ||
    !('randomness' in raw) ||
    typeof raw.randomness !== 'string' ||
    !('signature' in raw) ||
    typeof raw.signature !== 'string'
  ) {
    throw new BeaconUnavailableError();
  }
  const previous =
    'previous_signature' in raw ? raw.previous_signature : undefined;
  if (
    !/^[a-f0-9]{64}$/u.test(raw.randomness) ||
    !/^[a-f0-9]+$/u.test(raw.signature) ||
    (previous !== undefined &&
      (typeof previous !== 'string' || !/^[a-f0-9]+$/u.test(previous)))
  ) {
    throw new BeaconUnavailableError();
  }
  return previous === undefined
    ? {
        round: raw.round as number,
        randomness: raw.randomness,
        signature: raw.signature,
      }
    : {
        round: raw.round as number,
        randomness: raw.randomness,
        signature: raw.signature,
        previous_signature: previous,
      };
}

export async function readChainInfo(
  config: DrandConfiguration,
  request: typeof fetch = fetch,
): Promise<ChainInfo> {
  const infos = await Promise.allSettled(
    config.relays.map(async (relay) => {
      const info = (await readJson(
        `${chainPath(config, relay)}/info`,
        request,
      )) as ChainInfo;
      assertChainInfo(info, config);
      return info;
    }),
  );
  const valid = infos.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  if (
    valid.length < 2 ||
    valid.some(
      (info) =>
        info.period !== valid[0].period ||
        info.genesis_time !== valid[0].genesis_time ||
        info.schemeID !== valid[0].schemeID ||
        info.groupHash !== valid[0].groupHash,
    )
  ) {
    throw new BeaconUnavailableError();
  }
  return valid[0];
}

function recordedClient(
  info: ChainInfo,
  beacon: RandomnessBeacon,
): ChainClient {
  return {
    options: { disableBeaconVerification: false, noCache: true },
    chain: () => ({ baseUrl: 'recorded:offline', info: async () => info }),
    get: async () => beacon,
    latest: async () => beacon,
  };
}

export async function verifyRecordedBeacon(
  info: ChainInfo,
  beacon: RandomnessBeacon,
  expectedRound: number,
  config: DrandConfiguration,
): Promise<boolean> {
  try {
    assertChainInfo(info, config);
    await fetchBeacon(recordedClient(info, beacon), expectedRound);
    return true;
  } catch {
    return false;
  }
}

export async function fetchVerifiedBeacon(
  config: DrandConfiguration,
  info: ChainInfo,
  round: number,
  request: typeof fetch = fetch,
): Promise<VerifiedBeacon> {
  assertChainInfo(info, config);
  const responses = await Promise.allSettled(
    config.relays.map(async (relay) => {
      const beacon = asBeacon(
        await readJson(`${chainPath(config, relay)}/public/${round}`, request),
      );
      if (!(await verifyRecordedBeacon(info, beacon, round, config))) {
        throw new BeaconUnavailableError();
      }
      return { relay, beacon };
    }),
  );
  const valid = responses.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  const matching = valid
    .map((candidate) =>
      valid.filter(
        (result) =>
          result.beacon.randomness === candidate.beacon.randomness &&
          result.beacon.signature === candidate.beacon.signature,
      ),
    )
    .find((group) => group.length >= 2);
  if (matching === undefined) throw new BeaconUnavailableError();
  return {
    beacon: matching[0].beacon,
    relay: matching[0].relay,
    verifiedRelays: matching.map((result) => result.relay),
  };
}

export async function targetRoundAlreadyExists(
  config: DrandConfiguration,
  targetRound: number,
  request: typeof fetch = fetch,
): Promise<boolean> {
  const results = await Promise.allSettled(
    config.relays.map(async (relay) => {
      const beacon = asBeacon(
        await readJson(`${chainPath(config, relay)}/public/latest`, request),
      );
      return beacon.round >= targetRound;
    }),
  );
  const valid = results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value] : [],
  );
  if (valid.length < 2) throw new BeaconUnavailableError();
  return valid.some(Boolean);
}
