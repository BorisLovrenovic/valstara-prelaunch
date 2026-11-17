# P9 — Capturing the source pages for E11.6-01

**Who:** the founder. **When:** before E11.6-01 starts. **Time:** about 15 minutes of your attention, plus roughly an hour of the script waiting politely between requests.

## Why you capture the pages and the agent doesn't

`https://www.youfundceo.com/robots.txt` blocks AI agents (ClaudeBot, GPTBot and others) from the whole site, so no agent session may fetch it. You capture the pages. The agent then works out the site's structure, and builds and tests the scraper, from your saved copies alone. Those copies become the scraper's permanent test fixtures.

**What matters is saving the page exactly as the server sends it.** That is what the scraper will receive. The browser's "Save page as → Webpage, Complete" saves the page *after* the browser has rebuilt it, which is not what a scraper sees. The script below saves the server's response byte for byte. The browser steps add the two things a script cannot record: what the page looks like, and what extra data it loads.

## Is `/countries` enough?

**No.** `/countries` is only the list of countries and their links. The prices live on the country pages (`/countries/sweden`) and on the country × service pages (`/services/netflix/sweden`). So you capture:

| What | Why |
|---|---|
| `/countries`, `/services`, `/sitemap.xml`, `/robots.txt` | The slugs of every country and service, and the rules the scraper must follow |
| **A country page for each of the 38 countries below** | Every currency and number format the parser must read. They also show the "No price shown" section and which services each country lists |
| Two service pages (`/services/netflix`, `/services/spotify`) | What a service page holds, so the agent can tell whether the scraper needs it |
| **Country × service pages** for each tracked service in five markets | Plan-level prices (Netflix Basic, Standard and Premium), the "last checked" date and the USD figure. These are the pages the monthly run will mostly read |
| The "Price moves" page and the terms of use | The change cross-check, and whether the site allows automated access and reuse |

You only do this once. Every monthly run afterwards fetches its own pages.

## Where the files go

Save everything into your working copy of the repository, under:

```
packages/price-index/test/fixtures/youfundceo/
  raw/          the script's output: one .html (or .xml/.txt) and one .headers file per URL
  browser/      your screenshots and HAR files
  manifest.tsv  written by the script: URL, file, HTTP status, capture time, SHA-256
  urls-step1.txt
  urls-step2.txt
```

**Do not commit anything.** The E11.6-01 session checks the files and commits them on its own branch. Files you have not committed stay put when branches change.

## Step 1 — Look at the site in your browser (5 minutes)

Open `https://www.youfundceo.com/` and note three things:

1. **The link to the "Price moves" page.** Copy its full URL.
2. **The link to the terms of use** (usually in the footer). Copy its full URL.
3. **The country slugs.** Open `https://www.youfundceo.com/countries` and hover over a few countries. Do Czech Republic, Bosnia and Herzegovina, North Macedonia, the United Kingdom and the United States use the slugs guessed below? If one differs (`czechia` instead of `czech-republic`, say), fix that line in the list before running.

## Step 2 — Save the capture script

Save this as `capture.sh` **outside the repository** (e.g. `~/youfundceo-capture/capture.sh`), so it is never committed. It requests one URL at a time and waits 10–20 seconds between requests. It identifies itself honestly as Valstara, and stops by itself after three failed requests in a row.

```bash
#!/usr/bin/env bash
# Usage: bash capture.sh <urls-file> <output-dir>
set -uo pipefail
urls="$1"
out="$2"
ua='ValstaraPriceIndex/0.1 (one-off fixture capture; +https://valstara.com)'
mkdir -p "$out/raw"
manifest="$out/manifest.tsv"
[ -f "$manifest" ] || printf 'url\tfile\tstatus\tcaptured_at\tsha256\n' > "$manifest"
fails=0
first=1
while IFS= read -r url || [ -n "$url" ]; do
  case "$url" in ''|'#'*) continue ;; esac
  case "$url" in */api/*|*/go/*) echo "skip (disallowed by robots.txt): $url"; continue ;; esac
  [ "$first" -eq 1 ] || sleep $((10 + RANDOM % 11))
  first=0
  name=$(printf '%s' "${url#https://www.youfundceo.com/}" | sed 's#/$##; s#[/?=&]#__#g')
  [ -n "$name" ] || name=home
  case "$name" in *.txt|*.xml) file="$name" ;; *) file="$name.html" ;; esac
  status=$(curl -sS --compressed --max-time 30 -A "$ua" \
    -D "$out/raw/$file.headers" -o "$out/raw/$file" -w '%{http_code}' "$url") || status=000
  stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  hash=-
  if [ -f "$out/raw/$file" ]; then
    hash=$( (sha256sum "$out/raw/$file" 2>/dev/null || shasum -a 256 "$out/raw/$file") | cut -d' ' -f1)
  fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$url" "raw/$file" "$status" "$stamp" "$hash" >> "$manifest"
  echo "$status  $url"
  case "$status" in
    200|304) fails=0 ;;
    404) echo "   404 — check this slug against the site and fix the line" ;;
    *) fails=$((fails + 1))
       echo "   problem ($status) — waiting a minute before the next request"
       sleep 60
       if [ "$fails" -ge 3 ]; then
         echo "Stopped after three failures in a row. Do not retry; tell the E11.6-01 session what happened."
         exit 2
       fi ;;
  esac
done < "$urls"
echo "Done. Manifest: $manifest"
```

## Step 3 — First pass: indexes and the 38 country pages (about 13 minutes)

Create `packages/price-index/test/fixtures/youfundceo/urls-step1.txt` with this content. Replace the two `PASTE-…` lines with the URLs you found in Step 1, and fix any slug that differed:

```
https://www.youfundceo.com/robots.txt
https://www.youfundceo.com/sitemap.xml
https://www.youfundceo.com/countries
https://www.youfundceo.com/services
https://www.youfundceo.com/services/netflix
https://www.youfundceo.com/services/spotify
PASTE-THE-PRICE-MOVES-URL-HERE
PASTE-THE-TERMS-OF-USE-URL-HERE
https://www.youfundceo.com/countries/sweden
https://www.youfundceo.com/countries/germany
https://www.youfundceo.com/countries/united-kingdom
https://www.youfundceo.com/countries/poland
https://www.youfundceo.com/countries/romania
https://www.youfundceo.com/countries/norway
https://www.youfundceo.com/countries/denmark
https://www.youfundceo.com/countries/switzerland
https://www.youfundceo.com/countries/canada
https://www.youfundceo.com/countries/australia
https://www.youfundceo.com/countries/austria
https://www.youfundceo.com/countries/belgium
https://www.youfundceo.com/countries/bosnia-and-herzegovina
https://www.youfundceo.com/countries/croatia
https://www.youfundceo.com/countries/cyprus
https://www.youfundceo.com/countries/czech-republic
https://www.youfundceo.com/countries/estonia
https://www.youfundceo.com/countries/finland
https://www.youfundceo.com/countries/france
https://www.youfundceo.com/countries/greece
https://www.youfundceo.com/countries/hungary
https://www.youfundceo.com/countries/iceland
https://www.youfundceo.com/countries/ireland
https://www.youfundceo.com/countries/italy
https://www.youfundceo.com/countries/latvia
https://www.youfundceo.com/countries/liechtenstein
https://www.youfundceo.com/countries/lithuania
https://www.youfundceo.com/countries/luxembourg
https://www.youfundceo.com/countries/malta
https://www.youfundceo.com/countries/netherlands
https://www.youfundceo.com/countries/new-zealand
https://www.youfundceo.com/countries/north-macedonia
https://www.youfundceo.com/countries/portugal
https://www.youfundceo.com/countries/serbia
https://www.youfundceo.com/countries/slovakia
https://www.youfundceo.com/countries/slovenia
https://www.youfundceo.com/countries/spain
https://www.youfundceo.com/countries/united-states
```

Then, from the repository root:

```bash
bash ~/youfundceo-capture/capture.sh packages/price-index/test/fixtures/youfundceo/urls-step1.txt packages/price-index/test/fixtures/youfundceo
```

Every line should print `200`. A `404` means a wrong slug: fix that line in a new file holding only the corrected lines, and run the script again on that file. It appends to the same manifest. **If you see `403` or `429`, or the script stops by itself, do not retry and do not try another network.** That is a finding for E11.6-01, and the browser fallback below is the next step.

## Step 4 — Second pass: country × service pages in five markets (about 25 minutes)

Open `https://www.youfundceo.com/services` in your browser. For each product we track, find its slug: the last part of its link, e.g. `netflix` in `/services/netflix`. These are the products to look for:

- Adobe Creative Cloud
- Amazon Prime / Prime Video
- Apple TV
- Apple Music
- Bolt.new
- Canva
- ChatGPT
- Crunchyroll
- Duolingo
- Figma
- LinkedIn Premium
- Lovable
- MyFitnessPal
- n8n
- Netflix
- Notion
- Perplexity
- Spotify
- YouTube Premium

**A product that isn't on the site gets no line.** Just note it; it will be flagged as `missing` for manual entry, which is expected.

Write the slugs you found, one per line, into `~/youfundceo-capture/services.txt`. Then generate the URL list and run the script:

```bash
for s in $(cat ~/youfundceo-capture/services.txt); do for c in sweden germany united-kingdom switzerland united-states; do echo "https://www.youfundceo.com/services/$s/$c"; done; done > packages/price-index/test/fixtures/youfundceo/urls-step2.txt
```

```bash
bash ~/youfundceo-capture/capture.sh packages/price-index/test/fixtures/youfundceo/urls-step2.txt packages/price-index/test/fixtures/youfundceo
```

A `404` here can be genuine: the service may simply not be listed in that country. Leave it in the manifest. It tells the agent something.

## Step 5 — Browser evidence (5 minutes)

Use Chrome or Edge, and save into `packages/price-index/test/fixtures/youfundceo/browser/`.

**Full-page screenshots** of five pages:
- `/countries`
- `/countries/sweden`
- `/services/netflix`
- `/services/netflix/sweden`
- the Price moves page

For each one:
1. Open the page.
2. Press F12 to open the developer tools.
3. Press Ctrl+Shift+P (Cmd+Shift+P on a Mac), type `full size screenshot`, and press Enter.
4. Rename the file after the page, e.g. `countries__sweden.png`.

**Two HAR files**, for `/countries/sweden` and `/services/netflix/sweden`. These show any extra data the page loads after it arrives. For each page:
1. Open the developer tools and go to the Network tab.
2. Tick "Preserve log" and "Disable cache".
3. Reload the page and wait until it settles.
4. Click the download arrow ("Export HAR") and choose **"Export HAR (sanitized)…"** if it is offered. The sanitised export leaves out your cookies.
5. Save it as e.g. `countries__sweden.har`.

## Fallback if the script is refused

If Step 3 or Step 4 gets `403` or `429`, save the pages from the browser instead. For each URL:

1. Open `view-source:` followed by the URL, e.g. `view-source:https://www.youfundceo.com/countries/sweden`.
2. Press Ctrl+S (Cmd+S on a Mac), and choose **"Webpage, HTML Only"** — never "Webpage, Complete".
3. Name the file the way the script would, i.e. the path with `/` replaced by `__`, e.g. `countries__sweden.html`, and save it into `raw/`.

Then tell the E11.6-01 session that the browser was used and the script was refused. That is itself a finding about how the monthly scraper will fare.

## When you are done

Check:
- `manifest.tsv` has a line for every URL;
- `raw/` has the 38 country pages;
- `browser/` has five screenshots and two HAR files.

Then start E11.6-01 and mark its register row `done` only after that session's pull request merges.
