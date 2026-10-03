import { runDsrCommand } from '../src/server/dsr/cli.ts';
await runDsrCommand('complete', process.argv.slice(2));
