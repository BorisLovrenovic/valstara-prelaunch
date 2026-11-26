import conventionDocument from '../../../config/utm-convention.json' with { type: 'json' };

import { parseUtmConvention, type UtmConvention } from './convention-rules.ts';

// E11.8-02: the UTM convention, `config/utm-convention.json`. It lists the
// `utm_source` and `utm_medium` values the per-platform report prints; any
// other value is counted under `other` and never printed. Adding a platform
// is a change to that file alone. `npm run check` validates the file
// (scripts/ci/utm-convention-check.ts), and this module validates it again
// when it loads, so a malformed list fails startup once the route imports it.

/** The committed convention, validated when this module loads. */
export const utmConvention: UtmConvention =
  parseUtmConvention(conventionDocument);
