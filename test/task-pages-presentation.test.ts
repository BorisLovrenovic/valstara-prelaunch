import assert from 'node:assert/strict';
import test from 'node:test';

import { dsrCopy } from '../src/copy/dsr.ts';
import {
  dsrExportResponse,
  dsrOutcomeStatus,
  dsrResponse,
  type DsrOutcome,
} from '../src/server/dsr/http.ts';
import {
  dsrPageView,
  type DsrPageOutcome,
} from '../src/server/dsr/page-presentation.ts';
import {
  awardNoticeTone,
  awardTile,
} from '../src/server/giveaway/award-presentation.ts';

// E11.5-11t: the /dsr page's own POST shares the DSR logic through a typed
// outcome. These are the exact E9-05 bodies the API routes served before the
// refactor, written out, so a changed status, code or message fails here.
const apiResponses: Record<DsrPageOutcome, { status: number; body: unknown }> =
  {
    accepted: { status: 200, body: { message: dsrCopy.accepted } },
    pending: { status: 200, body: { message: dsrCopy.pending } },
    export_used: { status: 200, body: { message: dsrCopy.exportUsed } },
    invalid: {
      status: 400,
      body: { error: { code: 'invalid_input', message: dsrCopy.invalid } },
    },
    unavailable: {
      status: 503,
      body: { error: { code: 'unavailable', message: dsrCopy.unavailable } },
    },
    rate_limited: {
      status: 429,
      body: { error: { code: 'rate_limited', message: dsrCopy.rateLimited } },
    },
    challenge_failed: {
      status: 400,
      body: {
        error: { code: 'challenge_failed', message: dsrCopy.challengeFailed },
      },
    },
  };

test('every DSR outcome keeps its /api/dsr/* status, body and headers, and the page uses the same status', async () => {
  for (const [kind, expected] of Object.entries(apiResponses)) {
    const outcome = { kind } as DsrOutcome;
    const response = dsrResponse(outcome);
    assert.equal(response.status, expected.status, kind);
    assert.equal(
      await response.text(),
      JSON.stringify(expected.body),
      `${kind} body`,
    );
    assert.equal(
      response.headers.get('content-type'),
      'application/json; charset=utf-8',
    );
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(
      dsrOutcomeStatus[kind as DsrPageOutcome],
      expected.status,
      `${kind} page status`,
    );
  }
  assert.deepEqual(
    Object.keys(dsrOutcomeStatus).sort(),
    Object.keys(apiResponses).sort(),
  );
});

test('a confirmed export is the same NDJSON attachment from either caller', async () => {
  const body = () =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode('{"table":"subscriber"}\n'),
        );
        controller.close();
      },
    });
  for (const response of [
    dsrExportResponse(body()),
    dsrResponse({ kind: 'export', body: body() }),
  ]) {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/x-ndjson');
    assert.equal(
      response.headers.get('content-disposition'),
      'attachment; filename="valstara-data.ndjson"',
    );
    assert.equal(response.headers.get('cache-control'), 'private, no-store');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(await response.text(), '{"table":"subscriber"}\n');
  }
});

test('/dsr renders each outcome from the dsrCopy strings, as the canvas draws it', () => {
  const expected: Record<
    DsrPageOutcome,
    {
      state: string;
      tone: string;
      message: string;
      form: 'request' | null;
      icon: string;
    }
  > = {
    accepted: {
      state: 'accepted',
      tone: 'success',
      message: dsrCopy.accepted,
      form: null,
      icon: 'shield',
    },
    pending: {
      state: 'pending',
      tone: 'success',
      message: dsrCopy.pending,
      form: null,
      icon: 'clock',
    },
    export_used: {
      state: 'used',
      tone: 'info',
      message: dsrCopy.exportUsed,
      form: 'request',
      icon: 'shield',
    },
    invalid: {
      state: 'invalid',
      tone: 'info',
      message: dsrCopy.invalid,
      form: 'request',
      icon: 'shield',
    },
    unavailable: {
      state: 'unavailable',
      tone: 'error',
      message: dsrCopy.unavailable,
      form: 'request',
      icon: 'shield',
    },
    rate_limited: {
      state: 'rate-limited',
      tone: 'wait',
      message: dsrCopy.rateLimited,
      form: 'request',
      icon: 'shield',
    },
    challenge_failed: {
      state: 'check-failed',
      tone: 'error',
      message: dsrCopy.challengeFailed,
      form: 'request',
      icon: 'shield',
    },
  };
  for (const operation of ['export', 'delete'] as const) {
    for (const [outcome, want] of Object.entries(expected)) {
      for (const hasToken of [false, true]) {
        const view = dsrPageView(
          operation,
          hasToken,
          outcome as DsrPageOutcome,
        );
        const label = `${operation} ${outcome}`;
        assert.equal(view.state, `${operation}-${want.state}`, label);
        assert.equal(view.heading, dsrCopy[operation].heading, label);
        assert.deepEqual(
          view.notice,
          { tone: want.tone, message: want.message },
          label,
        );
        // A POST outcome never renders the confirmation form again.
        assert.equal(view.form, want.form, label);
        assert.equal(view.icon, want.icon, label);
        assert.equal(view.tone, outcome === 'pending' ? 'neutral' : 'accent');
        assert.equal(
          view.line,
          outcome === 'pending' ? null : dsrCopy[operation].body,
          label,
        );
        assert.equal(view.privacyLink, outcome !== 'pending', label);
      }
    }
  }
});

test('/dsr on GET renders the request form or the signed-link confirmation', () => {
  for (const operation of ['export', 'delete'] as const) {
    assert.deepEqual(dsrPageView(operation, false, null), {
      state: `${operation}-request`,
      heading: dsrCopy[operation].heading,
      icon: 'shield',
      tone: 'accent',
      line: dsrCopy[operation].body,
      notice: null,
      form: 'request',
      privacyLink: true,
    });
    assert.deepEqual(dsrPageView(operation, true, null), {
      state: `${operation}-confirm`,
      heading: dsrCopy[operation].heading,
      icon: operation === 'export' ? 'download' : 'erase',
      tone: 'accent',
      line: dsrCopy[operation].body,
      notice: null,
      form: 'confirm',
      privacyLink: operation === 'delete',
    });
  }
});

test('the award card takes the canvas tile and notice kind for every state and outcome', () => {
  assert.deepEqual(awardTile('checks'), { icon: 'gift', tone: 'accent' });
  assert.deepEqual(awardTile('substitution'), { icon: 'gift', tone: 'accent' });
  assert.deepEqual(awardTile('confirmed'), {
    icon: 'check-circle',
    tone: 'success',
  });
  assert.deepEqual(awardTile('unavailable'), { icon: 'link', tone: 'neutral' });
  assert.deepEqual(awardTile('replaced'), { icon: 'gift', tone: 'neutral' });
  assert.deepEqual(awardTile('exhausted'), { icon: 'gift', tone: 'neutral' });

  assert.equal(awardNoticeTone('challenge_failed'), 'error');
  assert.equal(awardNoticeTone('invalid_input'), 'error');
  assert.equal(awardNoticeTone('rate_limited'), 'wait');
  assert.equal(awardNoticeTone('disabled'), 'info');
  assert.equal(awardNoticeTone('unavailable'), 'info');
  assert.equal(awardNoticeTone('replaced'), 'info');
  for (const outcome of [
    'accepted',
    'confirmed',
    'substitution_offered',
  ] as const)
    assert.equal(awardNoticeTone(outcome), 'success', outcome);
});
