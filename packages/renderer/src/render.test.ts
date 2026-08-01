import { describe, expect, it } from 'vitest';

import { handleRequest, type RenderRequest } from './index.js';

const request = (overrides: Partial<RenderRequest> = {}): RenderRequest => ({
  method: 'GET',
  path: '/',
  query: {},
  headers: {},
  ...overrides,
});

describe('the renderer', () => {
  it('answers any path with an HTML document', () => {
    for (const path of ['/', '/jane', '/terms', '/deep/unknown/path']) {
      const res = handleRequest(request({ path }));

      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.body.startsWith('<!DOCTYPE html>')).toBe(true);
    }
  });

  it('caches at the edge for 60s and never in the browser (ADR-0004)', () => {
    const res = handleRequest(request({ path: '/jane' }));

    expect(res.headers['cache-control']).toBe('public, s-maxage=60, max-age=0');
  });

  it('emits a self-contained document — no external stylesheet, no client runtime', () => {
    const { body } = handleRequest(request({ path: '/jane' }));

    expect(body).not.toMatch(/<script\b/i);
    expect(body).not.toMatch(/<link[^>]+stylesheet/i);
    expect(body).toMatch(/<style>/i);
  });

  it('names itself with the configured origin, not the host it was reached on', () => {
    process.env['SITE_ORIGIN'] = 'https://dev.linkix.io';
    try {
      const { body } = handleRequest(request({ path: '/jane' }));

      expect(body).toContain('<link rel="canonical" href="https://dev.linkix.io/jane"');
      expect(body).toContain('property="og:url" content="https://dev.linkix.io/jane"');
    } finally {
      delete process.env['SITE_ORIGIN'];
    }
  });

  it('serves a HEAD like its GET but without the body', () => {
    const head = handleRequest(request({ method: 'HEAD', path: '/jane' }));
    const get = handleRequest(request({ method: 'GET', path: '/jane' }));

    expect(head.status).toBe(200);
    expect(head.headers).toEqual(get.headers);
    expect(head.body).toBe('');
  });

  it('escapes what it echoes back — the reason the renderer uses JSX (ADR-0006)', () => {
    const { body } = handleRequest(request({ path: '/<script>alert(1)</script>' }));

    // `<` is escaped, so nothing user-supplied can open a tag. (`>` is left
    // alone, which is correct: it cannot start one.)
    expect(body).not.toMatch(/<script/i);
    expect(body).toContain('&lt;script');
  });

  it('refuses writes — it is a read-only origin', () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const res = handleRequest(request({ method, path: '/jane' }));

      expect(res.status).toBe(405);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['allow']).toBe('GET, HEAD');
    }
  });
});
