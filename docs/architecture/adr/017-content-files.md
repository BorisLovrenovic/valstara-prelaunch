# ADR-017: Trust and legal copy as content files at permanent URLs

- Status: Accepted
- Date: 2026-08-25
- Deciders: founder

## Context
`/legit`, `/guarantee`, `/about`, `/terms` and `/privacy` are the only content on this site that survives into the storefront. They also take the longest to write and carry the highest conversion value.

## Decision
**All trust and legal prose lives in `src/content/` as Markdown**, never inline in `.astro` markup. Scanned. Each content file **declares the storefront route it ports to**, and that mapping is the port checklist.

**The pages are built at their permanent URLs from day one**, so they never move and never lose accumulated authority.

## Alternatives rejected
- **Prose inline in components** — makes the launch port a rewrite instead of a copy, which is the specific cost ADR-002 needs kept small.
- **A headless CMS** — a vendor, an integration and a monthly line, for content edited a handful of times by one person.
- **Writing these pages in the storefront later** — throws away three months of accumulated ranking on the exact URLs that convert a suspicious visitor.

## Consequences
Porting is a copy operation. Frontmatter is schema-validated and **a validation failure fails the build** — a trust page that 404s in production is worse than a slow build.

The content collection frontmatter field is `portTarget`. The trust collection covers `legit.md`, `guarantee.md` and `about.md`; the legal collection covers `terms.md` and `privacy.md`. Their targets are the matching permanent routes. The pipeline ships before the founder's prose, so the collections begin empty and the page tickets supply the Markdown files.

One dependency this makes explicit: **the prose is a founder input.** The guarantee's terms, the sourcing explanation and the company details come from the brand and store documentation. **This repository does not author them**, and a page shell with placeholder prose is a blocker rather than a deliverable.
