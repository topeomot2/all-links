/**
 * The renderer's transport-independent request/response shapes.
 *
 * `handleRequest` is written against these rather than against a Lambda event,
 * so routing, freshness and status codes are testable without constructing one
 * — `handler.ts` is the only file that knows what a Function URL event is.
 */
export interface RenderRequest {
  method: string;
  /** Path only — no query string, no origin. */
  path: string;
  query: Record<string, string | undefined>;
  /** Lowercase header names. */
  headers: Record<string, string | undefined>;
}

export interface RenderResponse {
  status: number;
  /** Lowercase header names. */
  headers: Record<string, string>;
  body: string;
  isBase64Encoded?: boolean;
}

/**
 * A public Page: 60 seconds at the edge, never in a browser (ADR-0004). The
 * browser TTL is 0 so a suspension's invalidation is the whole remedy.
 */
export const PAGE_CACHE_CONTROL = 'public, s-maxage=60, max-age=0';

export const NO_STORE = 'no-store';

export function htmlResponse(body: string, cacheControl: string, status = 200): RenderResponse {
  return {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': cacheControl,
    },
    body,
  };
}

export function methodNotAllowed(): RenderResponse {
  return {
    status: 405,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': NO_STORE,
      allow: 'GET, HEAD',
    },
    body: 'Method Not Allowed',
  };
}
