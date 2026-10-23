import { appendFileSync } from 'node:fs';

// Loaded with --import by discoverTestFiles(). In each test-file child of the
// Node test runner it records the file it was started for and exits before
// any test runs. The runner process itself is left alone.
if (process.env.NODE_TEST_CONTEXT !== undefined && process.argv[1]) {
  appendFileSync(process.env.VALSTARA_TEST_FILE_LIST, `${process.argv[1]}\n`);
  process.exit(0);
}
