import { relative } from 'node:path';

// A Node test reporter that writes each test file's wall time, in seconds, as
// JSON. With process isolation the runner reports every file as a top-level
// test named after its path; its duration covers module load, hooks and tests.
export default async function* testTimingReporter(source) {
  const timings = {};
  for await (const event of source) {
    if (event.type !== 'test:complete' || event.data.nesting !== 0) continue;
    if (!event.data.file) continue;
    const file = relative(process.cwd(), event.data.file).replaceAll('\\', '/');
    if (event.data.name !== file) continue;
    timings[file] = Math.round(event.data.details.duration_ms / 100) / 10;
  }
  const sorted = Object.fromEntries(
    Object.entries(timings).sort(([a], [b]) => a.localeCompare(b)),
  );
  yield `${JSON.stringify(sorted, null, 2)}\n`;
}
