/**
 * The Username's shape and the names no Account may ever Claim (ADR-0007).
 *
 * `core` owns both, so the dashboard's availability check, the claim
 * transaction and the public renderer cannot drift into three answers to
 * "is this name usable?".
 */

/**
 * 3–30 characters of `a-z 0-9 - _`, as alphanumeric runs joined by *single*
 * separators — so a separator can never lead, trail or double, and no Page URL
 * can ever contain something needing percent-encoding.
 */
export const USERNAME_PATTERN = /^(?=.{3,30}$)[a-z0-9]+(?:[_-][a-z0-9]+)*$/;

/**
 * Usernames are lowercase-canonical: typed uppercase is silently lowercased
 * rather than rejected, so `/Jane` and `/jane` are the same handle.
 */
export function canonicalUsername(input: string): string {
  return input.toLowerCase();
}

/** Tests the literal string — canonicalise first if it came from a human. */
export function isValidUsername(input: string): boolean {
  return USERNAME_PATTERN.test(input);
}

/**
 * Names reserved ahead of need: the routing and marketing namespace, authority
 * and impersonation words, and the brand with its near-variants.
 *
 * No profanity list — false positives are endemic (the Scunthorpe problem),
 * the list needs perpetual maintenance, and takedown is already the lever.
 *
 * `a`, `px`, `r` and `i` need no entry: the 3-character minimum excludes them.
 */
const BASE_RESERVED = [
  // Routing and marketing namespace, with no route behind them.
  'api',
  'app',
  'about',
  'blog',
  'docs',
  'help',
  'status',
  'contact',
  'admin',
  'assets',
  'static',
  // Authority and impersonation.
  'support',
  'billing',
  'security',
  'staff',
  'team',
  'official',
  'moderator',
  'abuse',
  'legal',
  'noreply',
  'no-reply',
  'www',
  'mail',
  // The brand and its near-variants.
  'all-links',
  'alllinks',
  'all_links',
  'all-link',
  'alllink',
  'allinks',
] as const;

/**
 * Names that will gain a static route in T3.
 *
 * ADR-0013 makes the denylist *derived* — `RESERVED = BASE_RESERVED ∪
 * keys(STATIC_ROUTES)` — so adding a root route reserves its name in the same
 * expression. `STATIC_ROUTES` arrives with the routes themselves; until then
 * these are listed, because `/terms` must not offer to sell the name `terms`.
 */
const ROUTED_NAMES = ['terms', 'privacy', 'login', 'signup', 'pricing'] as const;

export const RESERVED: ReadonlySet<string> = new Set<string>([...BASE_RESERVED, ...ROUTED_NAMES]);

/** Canonicalises first, so `API` is not a way past the denylist. */
export function isReservedUsername(input: string): boolean {
  return RESERVED.has(canonicalUsername(input));
}
