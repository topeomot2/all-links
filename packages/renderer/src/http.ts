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

/**
 * A Static route: five minutes at the edge (ADR-0013). Long enough to cut the
 * front door's cold-start exposure ~5× — `/` is the hottest path in the system
 * and the least forgiving visitor arrives there — and short enough that a copy
 * fix never needs an invalidation, which is what keeps ADR-0004's single
 * invalidation trigger single.
 */
export const STATIC_CACHE_CONTROL = 'public, s-maxage=300, max-age=0';

export const NO_STORE = 'no-store';

export const HTML = 'text/html; charset=utf-8';

export function textResponse(
  body: string,
  contentType: string,
  cacheControl: string,
  status = 200,
): RenderResponse {
  return {
    status,
    headers: {
      'content-type': contentType,
      'cache-control': cacheControl,
    },
    body,
  };
}

export function htmlResponse(body: string, cacheControl: string, status = 200): RenderResponse {
  return textResponse(body, HTML, cacheControl, status);
}

/** A file the renderer holds rather than renders — the brand card (ADR-0013). */
export function binaryResponse(
  base64: string,
  contentType: string,
  cacheControl: string,
): RenderResponse {
  return { ...textResponse(base64, contentType, cacheControl), isBase64Encoded: true };
}

/**
 * **302, never 301** (ADR-0008, restated by ADR-0013): a permanent redirect is
 * cached in browsers we do not control, and none of these targets is settled
 * enough to burn in. `max-age=0` says the same thing a second way — only the
 * edge copy is cached, and the edge is ours to drop.
 */
export function redirectResponse(location: string, cacheControl: string): RenderResponse {
  return {
    status: 302,
    headers: {
      location,
      'cache-control': cacheControl,
    },
    body: '',
  };
}

/**
 * A read that failed, not an answer.
 *
 * `no-store` is the load-bearing part: a 404 or an empty Page cached for 60
 * seconds would turn a momentary DynamoDB blip into a minute of wrong answers
 * at every edge, and there is no routine invalidation to pull it back.
 */
export function serverError(): RenderResponse {
  return {
    status: 500,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': NO_STORE,
    },
    body: 'Internal Server Error',
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
