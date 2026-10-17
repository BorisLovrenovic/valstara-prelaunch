import { runDsrCommand } from '../src/server/dsr/cli.ts';
await runDsrCommand('request', process.argv.slice(2));
