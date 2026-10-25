process.once('SIGTERM', () => process.exit(0));
await import('../../.astro/provider-showcase-fixture/server/entry.mjs');
