import assert from 'node:assert/strict';
import test from 'node:test';

import { createDrawRoute } from '../src/pages/api/admin/draw.ts';
import {
  DrawRefusedError,
  DrawUnavailableError,
} from '../src/server/giveaway/draw.ts';

const context = { locals: { adminActor: 'operator' } } as Parameters<
  ReturnType<typeof createDrawRoute>
>[0];

test('the admin draw route passes the recorded actor and returns the pending commitment', async () => {
  const route = createDrawRoute({
    executeDraw: async (actor) => {
      assert.equal(actor, 'operator');
      return {
        id: 'draw-id',
        targetRound: 101,
        targetRoundAt: new Date('2026-09-26T18:00:00.000Z'),
      };
    },
  });
  const response = await route(context);
  assert.equal(response.status, 202);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), {
    draw: {
      id: 'draw-id',
      state: 'pending',
      target_round: 101,
      target_round_at: '2026-09-26T18:00:00.000Z',
    },
  });
});

test('the admin draw route distinguishes a closed draw from an unavailable draw', async () => {
  const closed = await createDrawRoute({
    executeDraw: async () => {
      throw new DrawRefusedError('already committed');
    },
  })(context);
  assert.equal(closed.status, 400);
  assert.equal((await closed.json()).error.code, 'invalid_input');

  const unavailable = await createDrawRoute({
    executeDraw: async () => {
      throw new DrawUnavailableError('flag off');
    },
  })(context);
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).error.code, 'unavailable');
});
