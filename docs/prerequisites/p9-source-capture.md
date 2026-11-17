# P9 — Capturing the source pages for E11.6-01

**Who:** the founder or a helper, in Chrome. **When:** before E11.6-01 starts. **Time:** about an hour, with no technical steps.

## Why it is done in Chrome

`https://www.youfundceo.com` sits behind Vercel's bot protection. On 2026-11-17 a capture script got `robots.txt` and `sitemap.xml`, but every page answered with a "Vercel Security Checkpoint" (HTTP 429). Those responses are kept in `raw/` as evidence. Chrome passes the checkpoint by itself, so the pages are saved from Chrome. No AI agent session fetches the site, because its `robots.txt` blocks AI agents. The agent works on the saved copies alone, and they become the scraper's test fixtures.

## Where the files go

Inside the project folder, in `packages/price-index/test/fixtures/youfundceo/`:

```
raw/        already there: robots.txt, sitemap.xml and the three checkpoint responses
pages/      every page you save (create this folder)
browser/    the screenshots and the two HAR files (create this folder)
```

**Do not commit anything.** The E11.6-01 session checks the files, writes `manifest.tsv` and commits them on its own branch.

## How to save one page

Do this for every address in the lists below:

1. Open the address in Chrome. You may see a short "Security Checkpoint" spinner first. **Wait until the real page and its prices show.**
2. Press **Ctrl+S**.
3. Under **Save as type**, choose **"Webpage, Single File"**.
4. Name the file after the address: take the part after `youfundceo.com/` and replace each `/` with `__`. For example, `countries/sweden` becomes `countries__sweden.mhtml`, and `services/netflix/sweden` becomes `services__netflix__sweden.mhtml`.
5. Save it into `pages/`.

If a page says it doesn't exist, skip it and note the address. That is useful information too.

## The pages

**Indexes:**

- `https://www.youfundceo.com/countries`
- `https://www.youfundceo.com/services`
- `https://www.youfundceo.com/services/netflix`
- `https://www.youfundceo.com/services/spotify`
- **The "Price moves" page.** Find its link on the home page, open it and save it as `price-moves.mhtml`
- **The terms of use** (usually linked in the footer). Save it as `terms.mhtml`

**The 38 country pages**, at `https://www.youfundceo.com/countries/<name>`. If a name below doesn't open, find the country on `/countries`, click it, and use the address Chrome shows:

`sweden` · `germany` · `united-kingdom` · `poland` · `romania` · `norway` · `denmark` · `switzerland` · `canada` · `australia` · `austria` · `belgium` · `bosnia-and-herzegovina` · `croatia` · `cyprus` · `czech-republic` · `estonia` · `finland` · `france` · `greece` · `hungary` · `iceland` · `ireland` · `italy` · `latvia` · `liechtenstein` · `lithuania` · `luxembourg` · `malta` · `netherlands` · `new-zealand` · `north-macedonia` · `portugal` · `serbia` · `slovakia` · `slovenia` · `spain` · `united-states`

**Twelve service-by-country pages**, at `https://www.youfundceo.com/services/<service>/<country>`. Take each of these six services, in Sweden and in the United States:

`adobe` · `apple-music` · `chatgpt` · `netflix` · `spotify` · `youtube-premium`

For example, `https://www.youfundceo.com/services/netflix/sweden` and `https://www.youfundceo.com/services/netflix/united-states`.

## Screenshots and network recordings

Save these into `browser/`.

**Five full-page screenshots**, of:

- `/countries`
- `/countries/sweden`
- `/services/netflix`
- `/services/netflix/sweden`
- the Price moves page

For each one:

1. Open the page and wait until it has fully loaded.
2. Press **F12** to open DevTools.
3. Press **Ctrl+Shift+P**, type `full size screenshot`, and press **Enter**. Chrome downloads a PNG.
4. Rename it the same way as the pages, e.g. `countries__sweden.png`, and move it into `browser/`.

**Two network recordings (HAR files)**, of `/countries/sweden` and `/services/netflix/sweden`. For each one:

1. Open the page and press **F12**.
2. Click the **Network** tab, and tick **Preserve log** and **Disable cache**.
3. Press **F5** to reload, and wait about 10 seconds.
4. Click the small **download arrow** in the Network toolbar ("Export HAR"). If Chrome offers **"Export HAR (sanitized)…"**, choose that, because it leaves out cookies.
5. Save it as `countries__sweden.har` or `services__netflix__sweden.har` in `browser/`.

## When you are done

Check that:

- `pages/` holds 6 index pages, 38 country pages and 12 service-by-country pages, minus any that didn't exist;
- `browser/` holds five screenshots and two HAR files.

Then start E11.6-01.
