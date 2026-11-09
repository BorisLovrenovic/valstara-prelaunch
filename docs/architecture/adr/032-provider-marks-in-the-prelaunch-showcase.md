# ADR-032: Provider marks in the pre-launch showcase

- Status: Accepted
- Date: 2026-10-25
- Deciders: founder

## Context

The landing page needs to show the launch catalogue without implying a commercial endorsement or inventing products. P8 supplies 34 confirmed providers, their marks and a catalogue confirmation by Boris Lovrenovic dated 2026-10-25.

## Decision

Show only the P8 confirmed providers, grouped by the survey v2 categories that have supply. Use each provider's own brand colour only inside its composed banner. Keep the page frame on Valstara tokens. Every banner has a tonal layer and a raised logo surface. Do not show a price, discount, product count, availability date or stock claim. The footer states that product names and logos belong to their owners and that Valstara is an independent seller without affiliation or endorsement.

The logo source is an official URL when supplied. Where the founder has no URL, record `founder-supplied` and the supply date. P8's mechanical rule derives the banner colour from the supplied mark. The only raster mark is AION2's WebP, by founder exception; the other 33 are optimised SVGs. All are same-origin, at most 12 KB and have intrinsic dimensions.

**E11.5-11d amendment, 2026-10-28.** Each banner is the wireframe's composition: the full-bleed brand colour, one tonal shape (white at 13% on near-black, white at 16% under white text, else ink at 10%), a white name chip holding the logo and the provider's name, and the category label in white or ink, whichever contrasts more. A provider whose logo is drawn only in white is marked `chipTone: "dark"` in the data file and gets the ink chip. CyberGhost is the current case. In the catalogue the logo's alt text is the provider name, and the visible name is hidden from assistive technology so it is not read twice. The no-figure rule holds: a test removes each banner's own name, since n8n, Microsoft 365 and AION2 contain digits, and asserts that no figure remains.

**E11.5-11n amendment, 2026-11-08 (founder decisions).** The catalogue banner follows the final design. It keeps the brand colour, the no-figure rule and the white or ink label, and adds a second tonal layer, a ring, to the shape. The composition cycles the canvas's six in catalogue order, with no per-brand override. The chip changes with the logo. A logo that is a wordmark already spelling the provider's name is marked in the data file with `wordmarkHeight`, a positive whole number of pixels: its optical height from the canvas. It shows alone at that height, with the provider's name as its alt text and no visible name. The 18 wordmarks are Perplexity, Cursor, Bolt.new, Lovable, n8n, Spotify, YouTube Premium, Prime Video, Netflix, Apple TV, LinkedIn, MyFitnessPal, Canva, Dropbox, NordVPN, Norton, Kaspersky and CyberGhost. Every other entry shows its icon mark beside the name, with the logo's alt text the name and the visible name hidden from assistive technology, as before. The build fails on an invalid `wordmarkHeight`. Banners are not focusable; the category rails stay the keyboard stops. The hero's stack and strip are unchanged.

**E11.5-11p addition, 2026-11-09.** The landing page's final call to action shows three logo-only banners, as the final-design canvas draws them: ChatGPT, Netflix and Microsoft 365, named in `src/content/landing-final.json` and checked against the showcase by the prebuild check. Each is the catalogue composition (brand colour, tonal shape and ring) with only the logo on its chip: no name, no category, no price, discount, count or date. The three sit in an `aria-hidden` visual, so their logos carry empty alt text, and none is focusable. They show from 48rem and are hidden on phones. No new mark or asset is added, and no third-party host is contacted.

## Consequences

The build validates every record and asset. A catalogue or asset change must update P8's source record and its confirmation before it can be shown. E11.5-05 composes the showcase into the landing page. No third-party logo host is contacted by a rendered page.
