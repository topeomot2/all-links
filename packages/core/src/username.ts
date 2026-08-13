/**
 * The Username's shape and the names no Account may ever Claim (ADR-0007).
 *
 * `core` owns both, so the dashboard's availability check, the claim
 * transaction and the public renderer cannot drift into three answers to
 * "is this name usable?".
 */
import { routeUsername, STATIC_ROUTES } from './routes.js';

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
 * The denylist is **derived, not maintained** (ADR-0013):
 *
 *     RESERVED = BASE_RESERVED ∪ keys(STATIC_ROUTES)
 *
 * Adding a root route reserves its name in the same expression, which retires
 * ADR-0007's standing rule that both had to be edited together — and with it
 * the one class of bug that could only ever surface on deploy day: shipping a
 * route whose name a creator already owns.
 *
 * `BASE_RESERVED` keeps only the names with *no* route behind them.
 */
export const RESERVED: ReadonlySet<string> = new Set<string>([
  ...BASE_RESERVED,
  ...[...STATIC_ROUTES.keys()].map(routeUsername),
]);

/** Canonicalises first, so `API` is not a way past the denylist. */
export function isReservedUsername(input: string): boolean {
  return RESERVED.has(canonicalUsername(input));
}
