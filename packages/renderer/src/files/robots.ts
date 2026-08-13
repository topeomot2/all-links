/**
 * `/robots.txt` — contents decided by ADR-0011, routed here by ADR-0013.
 *
 * Public Pages are `index,follow`: discovery is a creator sharing their own
 * link, and a Page is the thing worth finding. The four disallowed prefixes are
 * everything that is *not* a document:
 *
 * - **`/r/`** — the click redirector. Indexable Pages would otherwise invite
 *   every compliant crawler to increment `clickCount` by following the
 *   anchors, which is why ADR-0008's count gets a structural defence here
 *   rather than one more heuristic.
 * - **`/px`** — the view pixel, for the same reason from the other direction.
 * - **`/api/`** — never a document; `no-store` and authenticated.
 * - **`/app/`** — the dashboard shell, which renders nothing without a session.
 *
 * **No `Sitemap:` line.** There is no sitemap in v1: a machine-generated index
 * of every Page is the most attractive artifact we could hand an SEO spammer,
 * and enumerating Usernames needs a scan that does not exist.
 */
export const ROBOTS_TXT = `User-agent: *
Disallow: /r/
Disallow: /px
Disallow: /api/
Disallow: /app/
`;
