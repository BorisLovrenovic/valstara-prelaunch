process.once('SIGTERM', () => process.exit(0));

await import('../../dist/server/entry.mjs');
