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
  return { store, siteDomain: 'ourapp.com', lookedUp };
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
    expect(decodeURIComponent(href!)).toBe('mailto:abuse@ourapp.com?subject=Report: jane');
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
    for (const path of ['/support', '/api', '/terms', '/blog']) {
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
    for (const path of ['/deep/unknown/path', '/ab', '/jane.doe', '/-jane', '/']) {
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
