# P8 — Launch provider list and logo files

> **Status:** supplied by the founder on 2026-10-25. **All 34 providers are ready for E11.5-04.** This is the source record E11.5-04 builds `src/content/provider-showcase.json` from. The requirement itself is P8 in `docs/plan/development-plan.md` §2 and `docs/prerequisites/founder-prerequisites.md#p8`.
>
> The logo files are in `docs/prerequisites/p8-logos/`, byte-identical to the files the founder supplied, renamed to the slugs below. All are SVG except AION2, a WebP by founder exception (see [Founder decisions on four logos](#founder-decisions-on-four-logos-2026-10-25)). They are source files, not site assets. E11.5-04 optimises them into `public/images/providers/` and enforces the 12 KB limit there.

---

## What the founder decided (2026-10-25)

| Item | Decision |
|---|---|
| Categories shown | **AI tools, Streaming and subscriptions, Software, In-game currency.** Gift cards, game keys and game top-ups have no confirmed supply yet, so they are not advertised in the pre-launch campaign. Per P8, a category with no providers is left out |
| Catalogue confirmation | Every provider below is confirmed for the launch catalogue by **Boris Lovrenovic, 2026-10-25** |
| Logo source | **Founder-supplied, 2026-10-25.** The founder does not have a source URL for each file. The plan's P8 row and E11.5-04 are amended so the source field records `founder-supplied` with the supply date when there is no URL (founder-authorised 2026-10-25) |
| Brand colour | The founder has no brand hex values. Each colour is **derived from the supplied logo file** by the rule below (founder-authorised 2026-10-25) |
| Dark-theme variants | None supplied. P8 makes them optional |

### The brand-colour rule

Each logo is rendered on a transparent canvas, and only fully opaque pixels are counted.

1. If chromatic pixels cover at least 20% of the mark, take the most-covered chromatic colour. Otherwise take the most-covered neutral colour other than white.
2. Snap that colour to the nearest hex declared in the SVG, if one lies within a distance of 24 in RGB. Otherwise keep the rendered colour. A raster logo declares no colours, so it keeps the rendered colour.

The rule is mechanical, so the same file always gives the same colour. For a mark with several equal areas, such as Figma's, the chosen colour is one of the official brand colours, not a designed choice. E11.5-04 uses it only as the banner's base colour (data, never a component literal).

---

## The provider list

Category tokens are the survey v2 tokens from E11.5-02 (ADR-031). Sizes are of the supplied file. **Every entry: confirmed by Boris Lovrenovic, 2026-10-25 · source `founder-supplied`, 2026-10-25 · no dark-theme variant.**

### AI tools — `ai`

| Display name | Slug and logo file | Brand colour | Size (bytes) |
|---|---|---|---|
| ChatGPT | `chatgpt.svg` | `#000000` | 1,739 |
| Gemini | `gemini.svg` | `#3186ff` | 8,712 |
| Perplexity | `perplexity.svg` | `#13343b` | 4,476 |
| Cursor | `cursor.svg` | `#26241e` | 6,200 |
| Bolt.new | `bolt-new.svg` | `#000000` | 3,868 |
| Lovable | `lovable.svg` | `#18181b` | 5,289 |
| n8n | `n8n.svg` | `#ea4b71` | 2,911 |

### Streaming and subscriptions — `subscriptions`

| Display name | Slug and logo file | Brand colour | Size (bytes) |
|---|---|---|---|
| Spotify | `spotify.svg` | `#1ed760` | 2,778 |
| YouTube Premium | `youtube-premium.svg` | `#ff0000` | 3,569 |
| Prime Video | `prime-video.svg` | `#00a8e1` | 8,712 |
| Netflix | `netflix.svg` | `#d81f26` | 1,118 |
| Apple Music | `apple-music.svg` | `#fb5c74` | 3,365 |
| Apple TV | `apple-tv.svg` | `#0d0d0d` | 1,478 |
| Crunchyroll | `crunchyroll.svg` | `#f78b24` | 142,830 |
| Discord | `discord.svg` | `#5865f2` | 2,039 |
| Duolingo | `duolingo.svg` | `#78c800` | 3,447 |
| LinkedIn | `linkedin.svg` | `#0a66c2` | 1,919 |
| MyFitnessPal | `myfitnesspal.svg` | `#0066ee` | 7,472 |
| PlayStation | `playstation.svg` | `#1f1f1f` | 4,776 |
| Xbox | `xbox.svg` | `#000000` | 4,102 |

### Software — `software`

| Display name | Slug and logo file | Brand colour | Size (bytes) |
|---|---|---|---|
| Microsoft | `microsoft.svg` | `#f35325` | 272 |
| Figma | `figma.svg` | `#ff7262` | 786 |
| Canva | `canva.svg` | `#00c4cc` | 15,727 |
| CapCut | `capcut.svg` | `#000000` | 3,451 |
| Notion | `notion.svg` | `#000000` | 1,578 |
| Dropbox | `dropbox.svg` | `#0061ff` | 3,916 |
| NordVPN | `nordvpn.svg` | `#4580ff` | 2,116 |
| Norton | `norton.svg` | `#fbde2a` | 3,448 |
| Kaspersky | `kaspersky.svg` | `#009982` | 2,395 |
| Adobe Creative Cloud | `adobe-creative-cloud.svg` | `#fb3f00` | 57,703 |
| Microsoft 365 | `microsoft-365.svg` | `#2d3f80` | 6,416 |
| CyberGhost | `cyberghost.svg` | `#ffcc00` | 4,725 |

### In-game currency — `in_game_currency`

| Display name | Slug and logo file | Brand colour | Size (bytes) |
|---|---|---|---|
| World of Warcraft | `world-of-warcraft.svg` | `#efd11a` | 19,793 |
| AION2 | `aion2.webp` | `#c7daff` | 26,822 |

Display names follow P8's rule, written as each provider writes them. The founder's list said "Youtube", "LinkedIN", "Playstation" and "Amazon Prime Video". These are recorded as YouTube Premium (the supplied mark is the Premium logo), LinkedIn, PlayStation and Prime Video (Amazon's own name for the service).

---

## Founder decisions on four logos (2026-10-25)

The first files for these four had problems. The founder resolved each one the same day:

| Provider | Decision |
|---|---|
| Adobe Creative Cloud | **The supplied file is accepted as it is**, after the founder's review. It is a PNG (240 × 234) embedded in an SVG wrapper |
| CyberGhost | **The supplied file is accepted as it is**, after the founder's review. Its wordmark is white |
| Microsoft 365 | **Replaced** by a new file, `microsoft365.svg`: the current Microsoft 365 icon (titled "Microsoft 365 logo (2022)"). The retired Office 365 file is not used, and the entry is named Microsoft 365 |
| AION2 | **The supplied WebP is used** (600 × 600 raster), because no SVG of the AION2 logo can be found. **This is the only non-SVG logo**, by founder exception for AION2 alone. Every other provider stays SVG |

Before these decisions, the official sites were checked on 2026-10-25. None offered a downloadable vector logo for these four.

---

## Notes for E11.5-04

- **Five files exceed the 12 KB limit** and need optimising: Crunchyroll (142,830 B, an Inkscape export), Adobe Creative Cloud (57,703 B), AION2 (26,822 B), World of Warcraft (19,793 B) and Canva (15,727 B). The rest are already under it. Adobe's size is its embedded PNG, so only re-encoding or downsizing that image reduces it; AION2 is a 600 × 600 WebP and can be resized to its display size.
- **No supplied file contains a script, an event handler or a linked resource.** Checked on 2026-10-25. The only embedded raster is Adobe Creative Cloud's PNG, inlined as a `data:` URI, so it causes no request. The only URLs are XML namespace and metadata identifiers: Inkscape and Dublin Core metadata in Crunchyroll, PlayStation, Xbox and YouTube Premium, and a DTD declaration in Cursor. None is fetched, and optimisation should strip them all.
- **Dark marks on dark surfaces.** Apple TV, Bolt.new, ChatGPT, Cursor, Notion, PlayStation and Xbox are single dark colours. Lovable, n8n, NordVPN, Norton, Perplexity, Dropbox and Crunchyroll have dark wordmarks. None comes with a dark-theme variant, so in the dark theme each needs the raised logo surface E11.5-04 already specifies.
- **CyberGhost's wordmark is white**, so it is legible only on a dark surface. In both themes it needs a dark logo surface, or its brand-colour background.
- **AION2 is a raster**, so it needs explicit intrinsic dimensions like the SVGs, and it cannot follow `currentColor` or be recoloured.
- `microsoft.svg` draws a light-grey (`#f3f3f3`) square behind the four squares.
- The file markers show where two files came from: `discord.svg` came from SVG Repo, and `office365.svg` (not used) did too. The others carry no marker. This is why the source field records `founder-supplied`.
