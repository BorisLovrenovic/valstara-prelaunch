import { runDsrCommand } from '../src/server/dsr/cli.ts';
await runDsrCommand('reapply', process.argv.slice(2));
