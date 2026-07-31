import { describe, expect, it } from 'vitest';

import { htmlResponse, methodNotAllowed, PAGE_CACHE_CONTROL, serverError } from './http.js';

describe('what the renderer lets the edge cache', () => {
  it('caches a Page for 60s at the edge and never in the browser (ADR-0004)', () => {
    const res = htmlResponse('<!DOCTYPE html>', PAGE_CACHE_CONTROL);

    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('public, s-maxage=60, max-age=0');
  });

  it('never caches a failed read', () => {
    // There is no routine invalidation (ADR-0004), so a cached blip would be a
    // minute of wrong answers at every edge with no lever to pull it back.
    const res = serverError();

    expect(res.status).toBe(500);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('never caches a refused method, and says which ones it takes', () => {
    const res = methodNotAllowed();

    expect(res.status).toBe(405);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['allow']).toBe('GET, HEAD');
  });
});
