import { describe, expect, it } from 'vitest';

import {
  BRAND_CARD_PATH,
  DASHBOARD_PATH,
  matchStaticRoute,
  PRICING_ANCHOR,
  routeUsername,
  STATIC_ROUTES,
  type StaticRoute,
} from './routes.js';
import { isReservedUsername } from './username.js';

const routeAt = (path: string): StaticRoute | undefined => matchStaticRoute(path)?.route;

describe('the static route table (ADR-0013)', () => {
  it('serves the three pages v1 ships, and the two files at the root', () => {
    expect(routeAt('/')).toEqual({ kind: 'resource', resource: 'landing' });
    expect(routeAt('/terms')).toEqual({ kind: 'resource', resource: 'terms' });
    expect(routeAt('/privacy')).toEqual({ kind: 'resource', resource: 'privacy' });
    expect(routeAt('/robots.txt')).toEqual({ kind: 'resource', resource: 'robots' });
    expect(routeAt(BRAND_CARD_PATH)).toEqual({ kind: 'resource', resource: 'brand-card' });
  });

  it('gives the names a visitor types on purpose a destination, not a 404', () => {
    expect(routeAt('/login')).toEqual({ kind: 'redirect', location: DASHBOARD_PATH });
    expect(routeAt('/signup')).toEqual({ kind: 'redirect', location: DASHBOARD_PATH });
    // Pricing is stated inline on the landing page rather than on a route of
    // its own, so the name resolves to where the content actually is.
    expect(routeAt('/pricing')).toEqual({ kind: 'redirect', location: PRICING_ANCHOR });
  });

  it('holds nothing else — `about`, `blog`, `docs` and `help` are pages nobody wrote', () => {
    for (const path of ['/about', '/blog', '/docs', '/help', '/jane', '/index.html']) {
      expect(routeAt(path), path).toBeUndefined();
    }
  });

  it('strips one trailing slash, and reports the table’s own spelling back', () => {
    // The match carries the canonical path, not the requested one, so `/terms/`
    // and `/terms` name one document with one canonical URL.
    expect(matchStaticRoute('/terms/')).toEqual({
      path: '/terms',
      route: { kind: 'resource', resource: 'terms' },
    });
    expect(matchStaticRoute('/')?.path).toBe('/');
  });

  it('leaves path case alone, so routing never decides how `/JaneDoe` resolves', () => {
    // Deliberate (ADR-0013): `/Terms` misses the table and falls through to the
    // Username lookup, which canonicalises and finds `terms` reserved.
    expect(routeAt('/Terms')).toBeUndefined();
    expect(routeAt('/Login')).toBeUndefined();
  });

  it('does not match a deeper path that merely starts with a route', () => {
    for (const path of ['/terms/extra', '/loginx', '//terms']) {
      expect(routeAt(path), path).toBeUndefined();
    }
  });
});

describe('the derived reserved set (ADR-0013)', () => {
  it('reserves every static route path, by derivation rather than a second list', () => {
    // The invariant ADR-0013 made unrepresentable: `RESERVED` *is*
    // `BASE_RESERVED ∪ keys(STATIC_ROUTES)`, so a route added without a
    // denylist entry cannot exist. This walks the table to say so out loud.
    expect(STATIC_ROUTES.size).toBeGreaterThan(0);

    for (const path of STATIC_ROUTES.keys()) {
      expect(isReservedUsername(routeUsername(path)), path).toBe(true);
    }
  });
});
