process.once('SIGTERM', () => process.exit(0));

await import('../../.astro/interface-primitives-fixture/server/entry.mjs');
