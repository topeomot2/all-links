import type { LinkItem, PageItem, PageLookup, PageStore } from '@all-links/core';
import { linkKey, pageKey } from '@all-links/core';
import { describe, expect, it } from 'vitest';

import type { RenderRequest } from './http.js';
import { handleRequest, type RenderDeps } from './index.js';

const ACCOUNT = 'acct-1';

const request = (overrides: Partial<RenderRequest> = {}): RenderRequest => ({
  method: 'GET',
  path: '/jane',
  query: {},
  headers: {},
  ...overrides,
});

const page = (overrides: Partial<PageItem> = {}): PageItem => ({
  ...pageKey(ACCOUNT, 'jane'),
  accountId: ACCOUNT,
  username: 'jane',
  displayName: 'Jane Doe',
  themeId: 'slate',
  active: true,
  ...overrides,
});

const link = (
  linkId: string,
  rank: string,
  label: string,
  url = 'https://example.com',
): LinkItem => ({
  ...linkKey(ACCOUNT, linkId, 'jane', rank),
  linkId,
  label,
  url,
  rank,
});

/** Records what was looked up, and answers with a fixed outcome. */
function deps(lookup: PageLookup): RenderDeps & { lookedUp: string[] } {
  const lookedUp: string[] = [];
  const store: PageStore = {
    lookupPage(username) {
      lookedUp.push(username);
      return Promise.resolve(lookup);
    },
  };
  return { store, lookedUp };
}

const visible = (links: LinkItem[] = [], overrides: Partial<PageItem> = {}): PageLookup => ({
  kind: 'visible',
  page: page(overrides),
  links,
});

const render = (lookup: PageLookup, req: Partial<RenderRequest> = {}) =>
  handleRequest(request(req), deps(lookup));

describe('a visible Page', () => {
  it('is a self-contained document — inlined CSS, no stylesheet, no client runtime', async () => {
    const res = await render(visible([link('l1', 'a', 'Site')]));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(res.body).toMatch(/<style>/i);
    expect(res.body).not.toMatch(/<script\b/i);
    expect(res.body).not.toMatch(/<link[^>]+stylesheet/i);
  });

  it('caches at the edge for 60s and never in the browser (ADR-0004)', async () => {
    const res = await render(visible());

    expect(res.headers['cache-control']).toBe('public, s-maxage=60, max-age=0');
  });

  it('looks the username up once, from the path', async () => {
    const d = deps(visible());

    await handleRequest(request({ path: '/jane' }), d);

    expect(d.lookedUp).toEqual(['jane']);
  });

  it('names itself with the configured origin, not the host it was reached on', async () => {
    process.env['SITE_ORIGIN'] = 'https://dev.linkix.io';
    try {
      // Requested as `/Jane`: the canonical URL is built from the stored
      // Username, so one Page has one canonical URL however it was reached.
      const { body } = await render(visible(), { path: '/Jane' });

      expect(body).toContain('<link rel="canonical" href="https://dev.linkix.io/jane"');
      expect(body).toContain('property="og:url" content="https://dev.linkix.io/jane"');
    } finally {
      delete process.env['SITE_ORIGIN'];
    }
  });

  it('titles the document `displayName (@username)`, but only when they differ (ADR-0011)', async () => {
    const named = await render(visible([], { displayName: 'Jane Doe' }));
    const unnamed = await render(visible([], { displayName: '' }));

    expect(named.body).toContain('<title>Jane Doe (@jane)</title>');
    // A Page that never set a display name must not be titled `jane (@jane)`.
    expect(unnamed.body).toContain('<title>jane</title>');
  });

  it('shows the display name and bio', async () => {
    const res = await render(visible([], { bio: 'Maker of things' }));

    expect(res.body).toContain('Jane Doe');
    expect(res.body).toContain('Maker of things');
  });

  it('escapes user-supplied text rather than trusting it (ADR-0006)', async () => {
    const res = await render(
      visible([link('l1', 'a', '<script>alert(1)</script>')], {
        displayName: '<img src=x onerror=alert(1)>',
        bio: '"><script>alert(2)</script>',
      }),
    );

    // Every `<` is escaped, so nothing user-supplied can open a tag or an
    // attribute — the payloads survive as visible text, which is the point.
    expect(res.body).not.toMatch(/<script\b/i);
    expect(res.body).not.toContain('<img src=x');
    expect(res.body).toContain('&lt;script');
    expect(res.body).toContain('&lt;img src=x onerror=alert(1)');
  });

  it('points every Link at the click redirector, never at the destination', async () => {
    const res = await render(
      visible([link('l1', 'a', 'One', 'https://evil.example'), link('l2', 'b', 'Two')]),
    );

    expect(res.body).toContain('href="/r/jane/l1"');
    expect(res.body).toContain('href="/r/jane/l2"');
    expect(res.body).not.toContain('https://evil.example');
  });

  it('marks outbound Links `nofollow ugc noopener`', async () => {
    const res = await render(visible([link('l1', 'a', 'One')]));

    expect(res.body).toContain('rel="nofollow ugc noopener"');
  });

  it('keeps Links in the order the store returned them', async () => {
    const res = await render(
      visible([link('l1', 'a', 'First'), link('l2', 'b', 'Second'), link('l3', 'c', 'Third')]),
    );

    expect(res.body.indexOf('First')).toBeLessThan(res.body.indexOf('Second'));
    expect(res.body.indexOf('Second')).toBeLessThan(res.body.indexOf('Third'));
  });

  it('renders a Page with no Links at all', async () => {
    const res = await render(visible([]));

    expect(res.status).toBe(200);
    expect(res.body).toContain('Jane Doe');
  });

  it('emits the view pixel — two requests per page view, document plus pixel', async () => {
    const res = await render(visible([link('l1', 'a', 'One')]));

    expect(res.body).toContain('src="/px?u=jane"');
    // Nothing else may be fetched: the avatar is inline and the CSS is inlined.
    const sources = [...res.body.matchAll(/<img[^>]+src="([^"]*)"/g)].map((m) => m[1]);
    expect(sources).toEqual(['/px?u=jane']);
  });

  it('carries the abuse mailto — the only report intake channel (ADR-0010)', async () => {
    const res = await render(visible());

    // The subject carries the username, so triage is a mail filter.
    const href = /href="(mailto:[^"]+)"/.exec(res.body)?.[1];

    expect(href).toBeDefined();
    expect(decodeURIComponent(href!)).toBe('mailto:abuse@linkix.io?subject=Report: jane');
  });

  it('serves a HEAD like its GET but without the body', async () => {
    const get = await render(visible());
    const head = await render(visible(), { method: 'HEAD' });

    expect(head.status).toBe(get.status);
    expect(head.headers).toEqual(get.headers);
    expect(head.body).toBe('');
  });

  it('refuses writes without reading DynamoDB — it is a read-only origin', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const d = deps(visible());
      const res = await handleRequest(request({ method }), d);

      expect(res.status).toBe(405);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['allow']).toBe('GET, HEAD');
      expect(d.lookedUp).toEqual([]);
    }
  });
});

describe('the avatar', () => {
  it('is inlined as a data URI at its stored dimensions, so the layout cannot shift', async () => {
    const res = await render(visible([], { avatarWebp: 'UklGRg==', avatarW: 256, avatarH: 256 }));

    expect(res.body).toContain('src="data:image/webp;base64,UklGRg=="');
    expect(res.body).toContain('width="256"');
    expect(res.body).toContain('height="256"');
    expect(res.body).toContain('object-fit:cover');
  });

  it('is a themed CSS monogram when absent — zero bytes, zero requests, no <img>', async () => {
    const res = await render(visible([], { displayName: 'Jane Doe' }));

    expect(res.body).not.toContain('data:image/webp');
    // The view pixel is then the only image on the page.
    expect([...res.body.matchAll(/<img\b/g)]).toHaveLength(1);
    expect(res.body).toContain('>J<');
  });

  it('falls back to the username when there is no display name', async () => {
    const res = await render(visible([], { displayName: '' }));

    expect(res.body).toContain('>J<');
  });

  it('takes one whole character, not half a surrogate pair', async () => {
    const res = await render(visible([], { displayName: '🎧 Jane' }));

    expect(res.body).toContain('>🎧<');
  });

  it('draws the monogram in the Theme accent', async () => {
    const res = await render(visible([], { themeId: 'slate' }));

    expect(res.body).toContain('--accent:');
  });

  it('falls back to the default Theme rather than rendering unstyled', async () => {
    const res = await render(visible([], { themeId: 'a-theme-that-was-retired' }));

    expect(res.status).toBe(200);
    expect(res.body).toContain('--accent:');
  });
});

describe('the negative paths (spec §6.6)', () => {
  it('all 404 at the same freshness as a live Page', async () => {
    const cases: [PageLookup, string][] = [
      [{ kind: 'absent' }, '/nobody'],
      [{ kind: 'hidden' }, '/jane'],
      [{ kind: 'absent' }, '/support'],
      [{ kind: 'absent' }, '/deep/unknown/path'],
    ];

    for (const [lookup, path] of cases) {
      const res = await render(lookup, { path });

      expect(res.status, path).toBe(404);
      expect(res.headers['cache-control'], path).toBe('public, s-maxage=60, max-age=0');
      expect(res.headers['content-type'], path).toBe('text/html; charset=utf-8');
    }
  });

  it('offers an unclaimed username to the visitor, with a signup CTA', async () => {
    const res = await render({ kind: 'absent' }, { path: '/nobody' });

    expect(res.body).toContain('nobody');
    expect(res.body).toMatch(/available/i);
    expect(res.body).toContain('href="/app/"');
  });

  it('never names billing on a lapsed Page', async () => {
    const res = await render({ kind: 'hidden' });

    expect(res.body).not.toMatch(/billing|payment|subscription|expired|unpaid|card/i);
    expect(res.body).toMatch(/not active|isn’t active|isn't active/i);
  });

  it('gives a suspended Page the same body as a lapsed one — `hidden` carries no reason', async () => {
    // The gate reports only "hidden", so the renderer cannot leak moderation
    // state into a public document even by accident.
    const res = await render({ kind: 'hidden' });

    expect(res.body).not.toMatch(/suspend|takedown|violat/i);
  });

  it('offers no CTA on a hidden Page — the name is not for sale', async () => {
    const res = await render({ kind: 'hidden' });

    expect(res.body).not.toContain('href="/app/"');
  });

  it('tells the truth about a reserved name, and does not offer to sell it', async () => {
    // Reserved *and* unrouted — `/terms` has a page of its own now (ADR-0013),
    // and the table above answers it before this path is reached.
    for (const path of ['/support', '/api', '/blog', '/about', '/docs', '/help']) {
      const res = await render({ kind: 'absent' }, { path });

      expect(res.status, path).toBe(404);
      expect(res.body, path).toMatch(/reserved/i);
      expect(res.body, path).not.toContain('href="/app/"');
    }
  });

  it('never reads DynamoDB for a reserved name', async () => {
    const d = deps({ kind: 'absent' });

    await handleRequest(request({ path: '/support' }), d);

    expect(d.lookedUp).toEqual([]);
  });

  it('does not offer to sell a path that could never be a username', async () => {
    // `/` is absent deliberately: it is the landing page now, not a placeholder.
    for (const path of ['/deep/unknown/path', '/ab', '/jane.doe', '/-jane']) {
      const res = await render({ kind: 'absent' }, { path });

      expect(res.status, path).toBe(404);
      expect(res.body, path).not.toContain('href="/app/"');
    }
  });

  it('keeps placeholders out of the index (ADR-0011)', async () => {
    const cases: [PageLookup, string][] = [
      [{ kind: 'absent' }, '/nobody'],
      [{ kind: 'hidden' }, '/jane'],
      [{ kind: 'absent' }, '/support'],
      [{ kind: 'absent' }, '/deep/unknown/path'],
    ];

    for (const [lookup, path] of cases) {
      const res = await render(lookup, { path });

      expect(res.body, path).toContain('name="robots"');
      expect(res.body, path).toContain('noindex');
      // A 404 has no canonical form to point at, and naming one would invite
      // exactly the indexing the `noindex` above exists to prevent.
      expect(res.body, path).not.toContain('rel="canonical"');
    }
  });

  it('escapes the username it echoes back into a placeholder', async () => {
    const res = await render({ kind: 'absent' }, { path: '/<script>alert(1)</script>' });

    expect(res.body).not.toMatch(/<script\b/i);
  });

  it('serves a HEAD of a placeholder with the body dropped, not the status', async () => {
    const res = await render({ kind: 'absent' }, { path: '/nobody', method: 'HEAD' });

    expect(res.status).toBe(404);
    expect(res.body).toBe('');
  });
});

describe('path handling', () => {
  it('strips one trailing slash, so `/jane/` is Jane’s Page', async () => {
    const d = deps(visible());

    const res = await handleRequest(request({ path: '/jane/' }), d);

    expect(res.status).toBe(200);
    expect(d.lookedUp).toEqual(['jane']);
  });

  it('canonicalises case — usernames are lowercase-canonical (ADR-0007)', async () => {
    const d = deps(visible());

    const res = await handleRequest(request({ path: '/JaneDoe' }), d);

    expect(res.status).toBe(200);
    expect(d.lookedUp).toEqual(['janedoe']);
  });

  it('catches a reserved name typed in any casing', async () => {
    const d = deps({ kind: 'absent' });

    const res = await handleRequest(request({ path: '/Support' }), d);

    expect(res.body).toMatch(/reserved/i);
    expect(d.lookedUp).toEqual([]);
  });
});

describe('the static route table (ADR-0013)', () => {
  /** The store would happily answer — the table must be consulted first. */
  const staticRes = (path: string, method = 'GET') =>
    handleRequest(request({ path, method }), deps(visible()));

  it('wins over a Page, and costs no read at all', async () => {
    for (const path of ['/', '/terms', '/privacy', '/robots.txt', '/og-card.png', '/login']) {
      const d = deps(visible());

      const res = await handleRequest(request({ path }), d);

      expect(res.status, path).not.toBe(404);
      // The short-circuit is above the query, so marketing never touches
      // DynamoDB — `/` costs a Lambda invocation and nothing else.
      expect(d.lookedUp, path).toEqual([]);
    }
  });

  it('caches static routes for five minutes at the edge, never in the browser', async () => {
    for (const path of ['/', '/terms', '/privacy', '/robots.txt', '/og-card.png', '/pricing']) {
      const res = await staticRes(path);

      expect(res.headers['cache-control'], path).toBe('public, s-maxage=300, max-age=0');
    }
  });

  it('serves the landing page at `/`, with pricing inline and a CTA to the dashboard', async () => {
    const res = await staticRes('/');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.body.startsWith('<!DOCTYPE html>')).toBe(true);
    // The anchor `/pricing` redirects to, and the prices ADR-0002 fixed.
    expect(res.body).toContain('id="pricing"');
    expect(res.body).toContain('$20');
    expect(res.body).toContain('$2.99');
    expect(res.body).toContain('href="/app/"');
  });

  it('stops offering to sell the empty username — the defect S1 called not shippable', async () => {
    const res = await staticRes('/');

    expect(res.body).not.toMatch(/is available/i);
  });

  it('serves Terms and Privacy from their own components', async () => {
    const terms = await staticRes('/terms');
    const privacy = await staticRes('/privacy');

    expect(terms.status).toBe(200);
    expect(terms.body).toContain('Terms of Service');
    expect(privacy.status).toBe(200);
    expect(privacy.body).toContain('Privacy Policy');
    expect(terms.body).not.toBe(privacy.body);
  });

  it('keeps the marketing pages self-contained, like every other document', async () => {
    for (const path of ['/', '/terms', '/privacy']) {
      const res = await staticRes(path);

      expect(res.body, path).toMatch(/<style>/i);
      expect(res.body, path).not.toMatch(/<script\b/i);
      expect(res.body, path).not.toMatch(/<link[^>]+stylesheet/i);
    }
  });

  it('makes the marketing pages findable and shareable (ADR-0011, ADR-0013)', async () => {
    process.env['SITE_ORIGIN'] = 'https://linkix.io';
    try {
      const res = await staticRes('/terms/');

      expect(res.body).toContain('content="index,follow"');
      // Canonical comes from the table's own key, so `/terms/` and `/terms`
      // are one document with one URL.
      expect(res.body).toContain('<link rel="canonical" href="https://linkix.io/terms"');
      expect(res.body).toContain('property="og:image" content="https://linkix.io/og-card.png"');
      expect(res.body).toContain('name="twitter:card" content="summary"');
    } finally {
      delete process.env['SITE_ORIGIN'];
    }
  });

  it('serves robots.txt from the table, not from the SPA origin', async () => {
    const res = await staticRes('/robots.txt');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    // The click, the pixel, the api and the dashboard — everything that is not
    // a document (ADR-0011).
    expect(res.body).toContain('Disallow: /r/');
    expect(res.body).toContain('Disallow: /px');
    expect(res.body).toContain('Disallow: /api/');
    expect(res.body).toContain('Disallow: /app/');
    // Pages themselves stay indexable: sharing a link is the whole product.
    expect(res.body).not.toMatch(/^Disallow: \/$/m);
  });

  it('serves the brand card from the table as real PNG bytes', async () => {
    const res = await staticRes('/og-card.png');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.isBase64Encoded).toBe(true);

    const bytes = Buffer.from(res.body, 'base64');
    expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('sends the names a visitor guesses somewhere useful, with a 302 not a 301', async () => {
    const cases: [string, string][] = [
      ['/login', '/app/'],
      ['/signup', '/app/'],
      ['/pricing', '/#pricing'],
    ];

    for (const [path, location] of cases) {
      const res = await staticRes(path);

      // 302: a permanent redirect is cached in browsers we do not control, and
      // none of these targets is settled enough to burn in (ADR-0008).
      expect(res.status, path).toBe(302);
      expect(res.headers['location'], path).toBe(location);
      expect(res.body, path).toBe('');
    }
  });

  it('resolves a trailing slash, so `/terms/` is not a 404', async () => {
    const res = await staticRes('/terms/');

    expect(res.status).toBe(200);
    expect(res.body).toContain('Terms of Service');
  });

  it('leaves `/Terms` to the reserved body rather than lowercasing the path', async () => {
    // Deliberate (ADR-0013): routing must not decide how `/JaneDoe` resolves.
    // The honest answer still wins — the name is reserved, not for sale.
    const d = deps({ kind: 'absent' });

    const res = await handleRequest(request({ path: '/Terms' }), d);

    expect(res.status).toBe(404);
    expect(res.body).toMatch(/reserved/i);
    expect(res.body).not.toContain('href="/app/"');
    expect(d.lookedUp).toEqual([]);
  });

  it('serves a HEAD of a static route with the body dropped, not the headers', async () => {
    const get = await staticRes('/');
    const head = await staticRes('/', 'HEAD');

    expect(head.status).toBe(get.status);
    expect(head.headers).toEqual(get.headers);
    expect(head.body).toBe('');
  });
});

describe('the inlined stylesheet', () => {
  it('reaches the CSS parser unescaped — `<style>` is raw text, not markup', async () => {
    // Escaped, the font stack arrives as `&quot;Segoe UI&quot;`, which CSS
    // cannot parse — and it drops the whole `font` shorthand with it, taking
    // the document's size and line-height along.
    const cases = [
      await render(visible(), { path: '/jane' }),
      await render({ kind: 'absent' }, { path: '/nobody' }),
      await handleRequest(request({ path: '/' }), deps(visible())),
    ];

    for (const res of cases) {
      const css = /<style>([\s\S]*?)<\/style>/.exec(res.body)?.[1];

      expect(css).toBeDefined();
      expect(css).toContain('"Segoe UI"');
      expect(css).not.toContain('&quot;');
    }
  });
});
