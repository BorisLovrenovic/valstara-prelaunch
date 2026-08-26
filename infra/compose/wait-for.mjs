import assert from 'node:assert/strict';

const systemScheduler = {
  cancel: (handle) => globalThis.clearTimeout(handle),
  schedule: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  sleep: (delayMs) =>
    new Promise((resolve) => globalThis.setTimeout(resolve, delayMs)),
};

export async function waitFor(
  description,
  operation,
  expected,
  timeoutMs = 30_000,
  scheduler = systemScheduler,
) {
  let deadlineReached = false;
  let lastValue;
  const deadline = scheduler.schedule(() => {
    deadlineReached = true;
  }, timeoutMs);

  try {
    while (!deadlineReached) {
      try {
        lastValue = await operation();
        if (lastValue === expected) {
          return;
        }
      } catch (error) {
        lastValue = error instanceof Error ? error.message : String(error);
      }

      if (!deadlineReached) {
        await scheduler.sleep(500);
      }
    }
  } finally {
    scheduler.cancel(deadline);
  }

  assert.fail(
    `${description}: expected ${expected}, last observed ${lastValue}`,
  );
}
