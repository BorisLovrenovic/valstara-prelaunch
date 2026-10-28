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

## Consequences

The build validates every record and asset. A catalogue or asset change must update P8's source record and its confirmation before it can be shown. E11.5-05 composes the showcase into the landing page. No third-party logo host is contacted by a rendered page.
