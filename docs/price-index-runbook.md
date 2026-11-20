# Price-index runbook: the monthly run

Status: authoritative. Built by E11.6-15. The tool itself is described in `docs/modules/price-index.md`; the feature and the founder's decisions are in `docs/features/price-index.md`.

**Once a month, by hand, on the founder's machine.** There is no cron, no scheduled workflow and no notification (founder, 2026-11-17). Nothing here runs unless someone types it. The tool never touches the running site: new prices reach the pages only through a data pull request, CI, merge and the normal deploy.

A run, start to finish:

1. run `scrape`;
2. read the coverage report;
3. resolve `needs_review` and `conflict`, and add manual overrides and `not_offered` entries;
4. run `build-data` and `monthly-report`;
5. commit the data on `data/price-index-YYYY-MM` with `data(price-index): <month> run [PRICE-YYYY-MM]` and open a pull request;
6. CI, merge, and the normal build and deploy publish the pages.

Every command below runs from the repository root. `YYYY-MM` is the month of the run (e.g. `2026-11`), and `<Month YYYY>` its name (e.g. `November 2026`).

## How long it takes

| Step | Time |
|---|---|
| Preparing (a clean clone, `npm ci`, the image pull) | 5–10 minutes the first time, about 1 minute after |
| `scrape` | About 40 minutes. The first run (2026-11-20, `20261120T132953Z`) loaded 152 pages in 37½ minutes. A run the source slows down takes longer: each backoff waits 1 minute, doubling up to 15 |
| Reading the report and resolving flags | 15–45 minutes, depending on how many records are flagged |
| `build-data`, `monthly-report`, `npm run check` | about 5 minutes |
| The pull request's CI | about 15 minutes |

The scrape loads one page at a time with an 8–20-second pause between pages (`config/price-index.json`): the three index pages, then for each of the 20 markets its country page and one page per tracked service the source prices there. It needs no attention while it runs; leave the machine on and awake.

## 0. Prepare

From a clean clone, or a clean `main`:

```bash
git switch main && git pull
npm ci
git switch -c data/price-index-YYYY-MM
npm run price-index -- validate
```

`validate` must say the configuration and every data file are valid. If it does not, stop: `main` is broken, and that is fixed by an ordinary ticket, never inside a data run.

**Where the browser runs.** The tool drives the Chromium build that matches the installed `playwright` (1.62.1), and Chromium needs system libraries the machine may not have. Run the tool in the repository's pinned Playwright image, which carries both, as the P9 capture did. It needs Docker and no administrator rights. Define this once per terminal:

```bash
pi() {
  docker run --rm --init --name valstara-price-index \
    --user "$(id -u):$(id -g)" -e HOME=/tmp \
    -v "$PWD:$PWD" -w "$PWD" \
    mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e \
    npm run -s price-index -- "$@"
}
```

`pi scrape` is then the scrape. Only `scrape` needs the browser; every other command can run as `npm run price-index -- …` directly, and the steps below write them that way. On a machine where `npx playwright install --with-deps chromium` succeeds (it needs `sudo`), `npm run price-index -- scrape` works without the image.

## 1. Scrape

```bash
pi scrape
```

It prints the run id (the start time, e.g. `20261120T132953Z`) and, at the end, the coverage %, every count, the failed markets and the path of each file written: `data/raw/<run_id>/` (gitignored) holds the raw pages, `observations.json` and `preview.json`, and the preview coverage report is `reports/coverage-YYYY-MM-DD.md` and `.json`, dated by the day it was written. **It never writes `data/price-index/`.**

The exit code says what happened:

| Exit | Meaning | Do |
|---|---|---|
| `0` | Done | Go on to step 2 |
| `1` | A usage error, or refused before anything was written | Read the message; fix the command |
| `2` | **The source stopped the run**: backoff ran out, or it asked for too long a wait | See [When the source blocks the tool](#when-the-source-blocks-the-tool) |
| `3` | A configuration or data file is invalid | `main` is broken: stop, and fix it through a ticket |
| `4` | Interrupted (Ctrl-C, `docker stop`, SIGTERM) | Resume it (below) |

### Resuming a run

A run stopped by the source, interrupted, or killed with the machine keeps a checkpoint of the units it finished. Resume it with its id:

```bash
pi scrape --resume <run_id>
```

It fetches only the units the checkpoint lacks and rewrites the run's observations and preview. To stop a run cleanly, press Ctrl-C, or from another terminal `docker stop -t 90 valstara-price-index`: the tool finishes the page in progress (up to 60 seconds) and exits `4`.

A run of one market only is `pi scrape --market <code>`; a build of it keeps every other market's previous values.

### When the source blocks the tool

**Stop and decide; never work around it.** If the run exits `2`, or pages keep failing, do not retry in a loop, switch networks, add a proxy, change the browser's presentation, solve a CAPTCHA or fetch the pages any other way. The tool's politeness and its one-host allowlist are founder decisions, and the CI evasion scan refuses code that would change them.

What to do instead:

1. Wait. A block is often temporary; try `pi scrape --resume <run_id>` once, the next day.
2. If it still stops, the partial run can be built as it is: its failed markets keep their previous values, which turn `stale` after 45 days and then stop publishing on their own.
3. Missing values that matter can be entered by hand from the official sites (`override add`, step 3).
4. A source that blocks for good is a founder decision (a new source, or direct sources), recorded through the plan, not a change made during a run.

## 2. Read the coverage report

Open the Markdown report `scrape` printed (`reports/coverage-YYYY-MM-DD.md`). It is marked as a preview. To regenerate it from the data as it now stands, after decisions or overrides:

```bash
npm run price-index -- report
```

It rewrites the same day's `reports/coverage-YYYY-MM-DD.md` and `.json`, and `build-data` later replaces them with the final report. Read, in order:

- **Coverage**: the share of records the pages will publish, overall, per market and per service.
- **Flagged**: every `needs_review`, then `conflict`, then `stale` record, with the value it shows, any manual entry for it, and its notes. Each needs a decision (step 3), except a value whose note says it breaks the currency check: no approval can publish it, `review` refuses it, and it stays unpublished unless an official price in the market's own currency exists to enter by hand. Netflix in Romania (priced in EUR, not RON) is flagged this way every month.
- **Missing**: combinations the source does not price, grouped by service and reason. Most are expected and recur every month: 11 tracked products are not on the source at all, Adobe Creative Cloud is unmapped and Prime Video is not an alias of Amazon Prime (founder, 2026-11-17; `docs/features/price-index-source-findings.md`). Fill one by hand only where the official site shows the price, or record it as not offered.
- **Spot checks**: five `ok` records drawn from the run. **Open each official URL and compare the price.** A disagreement is recorded as a manual override (step 3).
- **Retirable overrides**: manual entries the scraper now agrees with. Retire them with `override retire` when convenient.
- **Untracked**: plans the source lists that the catalogue does not. They are suggestions only; adding a plan is a catalogue change through a ticket.

## 3. Resolve the flags

**Every `needs_review` and `conflict` is approved, rejected, or deliberately left unpublished.** A record left undecided stays flagged and does not publish, which is always safe.

Decide on the value a flagged record shows:

```bash
npm run price-index -- review approve --market <code> --service <service_id> --plan <plan_id> --actor "<your name>"
npm run price-index -- review reject  --market <code> --service <service_id> --plan <plan_id> --actor "<your name>"
```

Approve only after checking the value against the official page. The decision is appended to `data/price-index/approvals.json`, which is append-only: a mistaken decision is corrected by a later one, never by editing the file.

Record a price the official site shows, or a plan the service does not offer in a market (each asks one question per line; the source URL must be on the service's official host):

```bash
npm run price-index -- override add
npm run price-index -- override not-offered
npm run price-index -- override retire
```

Run `npm run price-index -- report` again until the Flagged section holds only what you mean to leave unpublished.

## 4. Build and report

```bash
npm run price-index -- build-data
npm run price-index -- monthly-report --month YYYY-MM
npm run check
```

`build-data` validates everything first and writes nothing if anything fails (exit `3`). Otherwise it appends the month's real price changes to `changes.json`, new page URLs to `published-urls.json`, and writes `latest.json`, a snapshot, `reports/runs/<run_id>.json` and the final coverage report. `monthly-report` writes `data/price-index/monthly/YYYY-MM.json` (the public report page) and `reports/monthly/YYYY-MM.md` (for outreach; its cross-check section is for the founder only). `npm run check` must pass before committing.

## 5. Commit and open the pull request

```bash
git add data/price-index reports
git status
git commit -m "data(price-index): <Month YYYY> run [PRICE-YYYY-MM]"
git push -u origin data/price-index-YYYY-MM
gh pr create --title "data(price-index): <Month YYYY> run [PRICE-YYYY-MM]" --body "<coverage %, counts, decisions taken, anything left unpublished>"
```

`git status` must show changes under `data/price-index/` and `reports/` only. `data/raw/` is gitignored and stays on the machine (the tool keeps the last six runs).

## 6. CI, merge and deploy

CI runs on the pull request like any other: the test suite validates the committed data files (`the committed data files are valid` in `test/price-index/validate-data.test.ts`), `npm run security` runs the append-only check on `approvals.json`, `changes.json` and `published-urls.json`, and the build generates every price page from the new `latest.json`. **Wait for every check to pass, then squash-merge by hand** (`main` has no branch protection, so `gh pr merge --auto` would merge at once without waiting). The merge builds the image; the deploy is the normal deploy (`docs/engineering/ci-cd.md`).

## A wrong price that has gone live

**Turn the `prices.pages` flag off**, with the audited flag CLI on the production host ([Setting a campaign flag](ops/runbook.md#setting-a-campaign-flag)):

```bash
docker compose -f infra/compose/docker-compose.production.yml run --rm --no-deps \
  maintenance node ./src/server/flags/cli.ts set prices.pages off --actor "<your name>"
```

Every `/prices/**` and `/price-index/**` route then answers `503` with `Retry-After` and `noindex` within the five-second flag cache, without a deploy, and the URLs keep their index status (`docs/architecture/fallbacks.md`). Then correct the record (a manual override, or a `review reject` of the value), run `build-data`, and ship it through a data pull request as above. Turn the flag back on once the corrected build is deployed.

A single page that should stop existing for good (a plan or market removed) is retired with `price-index retire-url <url> --to <hub> --actor "<your name>"`, so it answers `301` to its hub.
