// The price-index float scan (E11.6-03, epic rule 3). A float never holds a
// price, so the tool's own code never turns text into a JavaScript number the
// two usual ways: no `parseFloat` (bare or as `Number.parseFloat`) and no
// `Number(...)` call or `new Number(...)`. Prices are read by
// `packages/price-index/src/money/` into bigint minor units instead. The rule
// covers all of `packages/price-index/src/`, so no exception list can drift
// out of date.

const scannedRoot = 'packages/price-index/src/';
const codeExtensions = /\.(?:[cm]?[jt]sx?)$/;
const forbidden = [
  { pattern: /\bparseFloat\b/g, name: 'parseFloat' },
  { pattern: /(?<![\w$.])Number\s*\(/g, name: 'Number(' },
];

/** Issues for every float conversion in the price-index tool's source. */
export function scanPriceIndexFloats(files) {
  const issues = [];
  for (const file of files) {
    if (!file.path.startsWith(scannedRoot) || !codeExtensions.test(file.path)) {
      continue;
    }
    for (const { pattern, name } of forbidden) {
      for (const match of file.content.matchAll(pattern)) {
        const line = file.content.slice(0, match.index).split('\n').length;
        issues.push({
          message: `line ${line}: ${name} turns a value into a float; read prices with src/money (bigint minor units)`,
          path: file.path,
          scan: 'price-index-floats',
        });
      }
    }
  }
  return issues;
}
