/**
 * The renderer's view of one configured value: the origin it is served on.
 *
 * It cannot be derived from the request. CloudFront reaches the renderer over
 * a Function URL, so the `Host` a handler sees is `*.lambda-url.*.on.aws`, and
 * ADR-0004 deliberately keeps `Host` out of the cache key — forwarding it
 * would fragment every cached Page across apex and `www`. The stack therefore
 * injects `SITE_ORIGIN`, derived from the single base domain in `infra` (#27).
 */

/** No `SITE_ORIGIN` means nothing deployed set it — i.e. `tools/dev-server`. */
const LOCAL_ORIGIN = `http://localhost:${process.env['PORT'] ?? 3000}`;

/** `https://dev.linkix.io` — scheme and host, never a trailing slash. */
export function siteOrigin(): string {
  const configured = process.env['SITE_ORIGIN'];
  return configured ? configured.replace(/\/+$/, '') : LOCAL_ORIGIN;
}

/**
 * The abuse report mailbox (ADR-0010) — the intake channel every public Page
 * links in its footer.
 *
 * It is deliberately *not* derived from `siteOrigin()`: that is the stage's own
 * host, so `dev` would advertise `abuse@dev.linkix.io`, a mailbox nobody reads
 * and reports would vanish into. The address is the apex at every stage, so the
 * stack injects the base domain alongside the origin it derives from (#27).
 */
export function abuseEmail(): string {
  return `abuse@${process.env['BASE_DOMAIN'] ?? DEFAULT_BASE_DOMAIN}`;
}

/** Only reached by `tools/dev-server`; every deployed stage injects the real one. */
const DEFAULT_BASE_DOMAIN = 'linkix.io';

/**
 * The absolute URL for a path — `og:url`, `<link rel="canonical">` (ADR-0011)
 * and any absolute redirect. Paths arrive already decoded, so this re-encodes
 * what a URL requires and nothing else.
 */
export function canonicalUrl(path: string): string {
  // `//evil.com` and `/\evil.com` are protocol-relative: resolved against the
  // origin they would silently change host, and this string is what unfurlers
  // trust. Collapse the leading separators so a path stays a path.
  const normalised = `/${path.replace(/^[/\\]+/, '')}`;

  return new URL(normalised, `${siteOrigin()}/`).toString();
}
