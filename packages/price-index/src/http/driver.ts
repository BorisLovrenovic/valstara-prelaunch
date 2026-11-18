import type { RefusalReason } from './request-rule.ts';

// The browser driver is injected (E11.6-04): the fetcher decides what to open
// and when, and the driver only opens one page and reports what came back.
// `createPlaywrightDriver` is the real one; tests also use a fake.

export interface RefusedRequest {
  url: string;
  resourceType: string;
  reason: RefusalReason;
}

export interface LoadRequest {
  url: string;
  /** Whether a path on the source may be requested (robots.txt and /api/, /go/). */
  isPathOpenable(pathAndQuery: string): boolean;
  /**
   * `rendered`: the page as the browser shows it (the raw store's copy).
   * `body`: the main response's body as sent (robots.txt).
   */
  read: 'rendered' | 'body';
}

export type LoadResult =
  | {
      kind: 'loaded';
      /** The status of the latest main-frame response. */
      status: number;
      finalUrl: string;
      /** Still showing the bot checkpoint after its time to complete. */
      checkpoint: boolean;
      retryAfter: string | null;
      content: string;
      refused: RefusedRequest[];
    }
  | {
      kind: 'timeout' | 'error';
      message: string;
      refused: RefusedRequest[];
    };

export interface BrowserDriver {
  /** Opens one page. Never called while another load is in progress. */
  load(request: LoadRequest): Promise<LoadResult>;
  close(): Promise<void>;
}
