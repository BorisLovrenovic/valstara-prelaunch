import assert from 'node:assert/strict';
import test from 'node:test';

import { surveyCopy } from '../src/copy/survey.ts';
import { createSurveyRoute } from '../src/pages/api/survey.ts';
import type { SurveyCaptureInput } from '../src/server/survey/service.ts';

function context(body: URLSearchParams) {
  return {
    clientAddress: '198.51.100.42',
    request: new Request('https://valstara.test/api/survey', {
      body,
      method: 'POST',
    }),
  } as never;
}

test('the survey route carries explicit skips and the version to the service', async () => {
  let received: SurveyCaptureInput | undefined;
  const route = createSurveyRoute({
    async capture(input) {
      received = input;
      return 'skipped';
    },
    ipPrefixPepper: 'survey-route-prefix-pepper',
  });
  const response = await route(
    context(
      new URLSearchParams({ token: 'status-token', version: '2026-09-08' }),
    ),
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    message: surveyCopy.skipped,
    status: 'skipped',
  });
  assert.deepEqual(received?.answers, {
    category_preference: null,
    shopping_frequency: null,
  });
  assert.equal(received?.version, '2026-09-08');
  assert.match(received?.ipPrefixHash ?? '', /^[a-f0-9]{64}$/u);
});

test('the survey route exposes only closed error codes and maps unverified like an invalid token', async () => {
  for (const [outcome, expectedStatus, expectedCode] of [
    ['invalid_input', 400, 'invalid_input'],
    ['unverified', 400, 'token_invalid'],
    ['token_invalid', 400, 'token_invalid'],
    ['rate_limited', 429, 'rate_limited'],
    ['disabled', 503, 'unavailable'],
  ] as const) {
    const response = await createSurveyRoute({
      capture: async () => outcome,
      ipPrefixPepper: 'survey-route-prefix-pepper',
    })(
      context(
        new URLSearchParams({ token: 'status-token', version: '2026-09-08' }),
      ),
    );
    const payload = (await response.json()) as {
      error: { code: string; message: string };
    };
    assert.equal(response.status, expectedStatus);
    assert.equal(payload.error.code, expectedCode);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});
