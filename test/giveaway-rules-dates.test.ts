// E11.8-05: the code's giveaway dates follow the current rules revision.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import type { DatabasePool } from '../src/server/db/pool.ts';
import { giveawayEntryPeriodEnd } from '../src/server/giveaway/accrue.ts';
import { currentRulesFromFiles } from '../src/server/giveaway/current-rules-file.ts';
import {
  createDrawService,
  DrawRefusedError,
  publishedDrawStart,
} from '../src/server/giveaway/draw.ts';

const months = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

function section(body: string, number: number, heading: string): string {
  const start = body.indexOf(`\n## ${number}. ${heading}\n`);
  assert.notEqual(start, -1, `section ${number} is present`);
  const end = body.indexOf('\n## ', start + 1);
  return body.slice(start, end === -1 ? undefined : end);
}

function utcDay(day: string, month: string, year: string): number {
  const index = months.indexOf(month);
  assert.notEqual(index, -1, `${month} is a month name`);
  return Date.UTC(Number(year), index, Number(day));
}

/** The dates the current revision states, read from its own prose. */
async function currentRevisionDates(): Promise<{
  rulesVersion: string;
  lastEntryInstant: number;
  drawDay: number;
}> {
  const { rulesVersion } = await currentRulesFromFiles();
  const source = await readFile(
    new URL(
      `../src/content/giveaway-rules/${rulesVersion}.md`,
      import.meta.url,
    ),
    'utf8',
  );
  const close =
    /They close at \*\*(\d{2}):(\d{2}):(\d{2}) UTC on (\d{1,2}) ([A-Z][a-z]+) (\d{4})\*\*\./u.exec(
      section(source, 4, 'Entry period'),
    );
  assert.ok(close, 'Section 4 states when entries close');
  const draw =
    /^Winners are drawn on \*\*(\d{1,2}) ([A-Z][a-z]+) (\d{4})\*\* by /mu.exec(
      section(source, 8, 'How winners are chosen'),
    );
  assert.ok(draw, 'the draw section states the draw date');
  const [, hours, minutes, seconds, day, month, year] = close;
  return {
    rulesVersion,
    lastEntryInstant:
      utcDay(day, month, year) +
      ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1_000,
    drawDay: utcDay(draw[1], draw[2], draw[3]),
  };
}

test('the code dates equal the dates the current rules revision states', async () => {
  const dates = await currentRevisionDates();
  assert.equal(dates.rulesVersion, 'VAL-GW-LAUNCH-20261126-r1');
  // Section 4's close is the last whole second that counts, so the code's
  // exclusive end is one second later.
  assert.equal(
    giveawayEntryPeriodEnd.getTime(),
    dates.lastEntryInstant + 1_000,
    'giveawayEntryPeriodEnd is the first instant after the stated close',
  );
  assert.equal(
    publishedDrawStart.getTime(),
    dates.drawDay,
    "the draw's earliest start is 00:00 UTC on the stated draw day",
  );
  // The founder's dates (2026-11-24), so a revision that drifted together
  // with the code is caught as well.
  assert.equal(
    new Date(dates.lastEntryInstant).toISOString(),
    '2027-08-31T23:59:59.000Z',
  );
  assert.equal(
    giveawayEntryPeriodEnd.toISOString(),
    '2027-09-01T00:00:00.000Z',
  );
  assert.equal(publishedDrawStart.toISOString(), '2027-09-01T00:00:00.000Z');
});

test('the draw refuses to start before 1 September 2027 and opens at that instant', async () => {
  const reachedRules = new Error('reached the rules check');
  let now = new Date(0);
  let rulesReads = 0;
  const draw = createDrawService(
    // Nothing before the rules check touches the database.
    {} as DatabasePool,
    { isEnabled: async () => true },
    { send: async () => undefined },
    {
      clock: () => now,
      config: { chainHash: 'chain', publicKey: 'key', relays: [] },
      currentRules: async () => {
        rulesReads += 1;
        throw reachedRules;
      },
      reviewGate: { assertReviewedAndCurrent: async () => undefined },
      reconcile: async () => undefined,
      periodStart: null,
    },
  );
  for (const before of [
    '2027-04-01T00:00:00.000Z',
    '2027-08-31T23:59:59.999Z',
  ]) {
    now = new Date(before);
    await assert.rejects(
      draw.executeDraw('founder:test'),
      (error: unknown) =>
        error instanceof DrawRefusedError &&
        error.message === 'The published draw date has not arrived.',
      before,
    );
  }
  assert.equal(rulesReads, 0, 'a refused draw reads nothing further');
  for (const onOrAfter of [
    '2027-09-01T00:00:00.000Z',
    '2027-09-01T09:00:00.000Z',
  ]) {
    now = new Date(onOrAfter);
    await assert.rejects(
      draw.executeDraw('founder:test'),
      (error: unknown) => error === reachedRules,
      onOrAfter,
    );
  }
  assert.equal(rulesReads, 2);
});
