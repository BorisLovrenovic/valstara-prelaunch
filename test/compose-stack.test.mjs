import test from 'node:test';

import { assertStack } from '../infra/compose/assert-stack.mjs';

test(
  'the running Compose stack enforces memory limits and database separation',
  { timeout: 30_000 },
  async () => {
    await assertStack();
  },
);
