import type { StaticResource, StaticRouteMatch } from '@all-links/core';
import { BRAND_CARD_PATH, matchStaticRoute } from '@all-links/core';
import type { VNode } from 'preact';
import { render } from 'preact-render-to-string';

import { abuseEmail, canonicalUrl, siteHost } from './config.js';
import { BRAND_CARD_PNG_BASE64 } from './files/brand-card.js';
import { ROBOTS_TXT } from './files/robots.js';
import {
  binaryResponse,
  htmlResponse,
  redirectResponse,
  STATIC_CACHE_CONTROL,
  textResponse,
  type RenderResponse,
} from './http.js';
import { LandingDocument } from './pages/landing.js';
import { PrivacyDocument, TermsDocument } from './pages/legal.js';

const DOCTYPE = '<!DOCTYPE html>';

/**
 * The Static route half of the renderer (ADR-0013): the answer to a path in
 * `core`'s table, or `undefined` if the path is not in it.
 *
 * Every one of these is served **without touching DynamoDB** — the whole point
 * of sitting above the Username lookup — so the landing page costs a Lambda
 * invocation per edge per five minutes and nothing else.
 */
export function staticRouteResponse(path: string): RenderResponse | undefined {
  const match = matchStaticRoute(path);

  return match ? respond(match) : undefined;
}

function respond({ path, route }: StaticRouteMatch): RenderResponse {
  return route.kind === 'redirect'
    ? redirectResponse(route.location, STATIC_CACHE_CONTROL)
    : RESOURCES[route.resource](path);
}

/**
 * One answer per resource, keyed by the ids `core` declares.
 *
 * A total `Record` rather than a `switch`: adding a route to the table is a
 * compile error here until it has something to serve, so the table can never
 * name a resource that 500s at runtime.
 */
const RESOURCES: Record<StaticResource, (path: string) => RenderResponse> = {
  landing: (path) =>
    documentResponse(
      <LandingDocument
        siteHost={siteHost()}
        canonical={canonicalUrl(path)}
        cardUrl={brandCardUrl()}
      />,
    ),

  terms: (path) =>
    documentResponse(
      <TermsDocument
        abuseEmail={abuseEmail()}
        canonical={canonicalUrl(path)}
        cardUrl={brandCardUrl()}
      />,
    ),

  privacy: (path) =>
    documentResponse(
      <PrivacyDocument
        abuseEmail={abuseEmail()}
        canonical={canonicalUrl(path)}
        cardUrl={brandCardUrl()}
      />,
    ),

  robots: () => textResponse(ROBOTS_TXT, 'text/plain; charset=utf-8', STATIC_CACHE_CONTROL),

  'brand-card': () => binaryResponse(BRAND_CARD_PNG_BASE64, 'image/png', STATIC_CACHE_CONTROL),
};

/** Absolute, because an unfurler resolves `og:image` in its own context. */
function brandCardUrl(): string {
  return canonicalUrl(BRAND_CARD_PATH);
}

/** Marketing pages are the Page's machinery with different components. */
function documentResponse(node: VNode): RenderResponse {
  return htmlResponse(DOCTYPE + render(node), STATIC_CACHE_CONTROL);
}
