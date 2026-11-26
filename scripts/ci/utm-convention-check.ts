// E11.8-02: run by `npm run check`. config/utm-convention.json must list the
// recognised utm_source and utm_medium values, each already normalised,
// unique and not one of the report's own labels
// (src/server/source-report/convention-rules.ts). Any problem fails the check.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  utmConventionPath,
  utmConventionProblems,
} from '../../src/server/source-report/convention-rules.ts';

const source = await readFile(join(process.cwd(), utmConventionPath), 'utf8');
let problems: string[];
try {
  problems = utmConventionProblems(JSON.parse(source));
} catch {
  problems = ['not valid JSON'];
}
if (problems.length > 0) {
  process.stderr.write(
    `${utmConventionPath} failed its checks:\n${problems.map((problem) => `- ${problem}`).join('\n')}\n`,
  );
  process.exit(1);
}
