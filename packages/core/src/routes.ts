/**
 * The static route table (ADR-0013) — the paths the renderer answers from a
 * fixed table, *before* it looks a Username up.
 *
 * It lives in `core` for one reason: `RESERVED` is derived from its keys
 * (`username.ts`), so adding a root route reserves its name in the same
 * expression. ADR-0007's standing rule — "any route added must gain its
 * denylist entry in the same PR" — stops being a discipline and becomes an
 * identity.
 *
 * The table names *what* answers, never the bytes: the renderer owns the
 * documents and the files, because `core` is also bundled into the api and
 * counter Lambdas and neither has any business carrying marketing copy.
 */

/** Where the dashboard SPA is mounted (ADR-0004's routing table). */
export const DASHBOARD_PATH = '/app/';

/** The landing page's pricing section — `/pricing` exists as this anchor. */
export const PRICING_ANCHOR = '/#pricing';

/**
 * The Brand card (`CONTEXT.md`) — the `og:image` every surface falls back to.
 * Named here because T6's `/i/*` redirects to it as well as the table serving
 * it, and two spellings of one path is a broken card nobody notices.
 */
export const BRAND_CARD_PATH = '/og-card.png';

/**
 * Something the renderer can serve without reading DynamoDB.
 *
 * The renderer maps every id to a response through a total `Record`, so adding
 * one here is a type error until it has an answer — the table cannot name a
 * route nothing serves.
 */
export type StaticResource = 'landing' | 'terms' | 'privacy' | 'robots' | 'brand-card';

export type StaticRoute =
  | { kind: 'resource'; resource: StaticResource }
  /** 302, never 301 — ADR-0008's reason: none of these targets is settled. */
  | { kind: 'redirect'; location: string };

const resource = (resource: StaticResource): StaticRoute => ({ kind: 'resource', resource });
const redirect = (location: string): StaticRoute => ({ kind: 'redirect', location });

/**
 * Exact paths, lowercase, in ADR-0013's order. Three pages, two files, four
 * redirects — and nothing else: `about`, `blog`, `docs` and `help` are pages
 * nobody has written, so they stay reserved names with no route behind them.
 *
 * The redirects are here because a name a visitor typed on purpose deserves a
 * destination. `/app` is the dashboard without its slash; `/login` and
 * `/signup` are the one funnel's obvious guesses; `/pricing` is content that
 * exists but is not a page of its own.
 */
export const STATIC_ROUTES: ReadonlyMap<string, StaticRoute> = new Map<string, StaticRoute>([
  ['/', resource('landing')],
  ['/terms', resource('terms')],
  ['/privacy', resource('privacy')],
  ['/robots.txt', resource('robots')],
  [BRAND_CARD_PATH, resource('brand-card')],
  // `/app/` itself is an edge behavior to S3; only the slashless spelling
  // ever reaches the renderer.
  ['/app', redirect(DASHBOARD_PATH)],
  ['/login', redirect(DASHBOARD_PATH)],
  ['/signup', redirect(DASHBOARD_PATH)],
  ['/pricing', redirect(PRICING_ANCHOR)],
]);

export interface StaticRouteMatch {
  /**
   * The table's own key — the canonical spelling of the path, which is not
   * always the one that was asked for. `/terms/` matches and canonicalises to
   * `/terms`, so one document has one canonical URL however it was reached.
   */
  path: string;
  route: StaticRoute;
}

/**
 * The route at a path, or `undefined` if the path is not one.
 *
 * Matching is exact, with one trailing slash stripped so `/terms/` resolves —
 * safe above the Username lookup too, because a Username can never end in a
 * separator (ADR-0007).
 *
 * Case is deliberately left alone (ADR-0013): lowercasing the path here would
 * also decide how `/JaneDoe` resolves, which belongs to Username casing rather
 * than to routing. `/Terms` therefore misses the table and falls through to
 * the Username lookup — which canonicalises, finds `terms` reserved, and
 * answers with the reserved body rather than offering to sell the name.
 */
export function matchStaticRoute(path: string): StaticRouteMatch | undefined {
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const route = STATIC_ROUTES.get(trimmed);

  return route ? { path: trimmed, route } : undefined;
}

/**
 * The Username a route path occupies — the derivation `RESERVED` is built on.
 *
 * Paths that cannot be Usernames (`/` → `''`, `/og-card.png` → a name with a
 * dot in it) still map through: the entries are inert, because the username
 * regex rejects them long before the reserved check runs, and filtering them
 * out would put a second rule between the table and the denylist.
 */
export function routeUsername(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}
