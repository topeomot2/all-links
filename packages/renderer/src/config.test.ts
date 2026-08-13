import { afterEach, describe, expect, it } from 'vitest';

import { canonicalUrl, siteOrigin } from './index.js';

const withOrigin = (value: string | undefined): void => {
  if (value === undefined) delete process.env['SITE_ORIGIN'];
  else process.env['SITE_ORIGIN'] = value;
};

afterEach(() => withOrigin(undefined));

describe('the configured site origin', () => {
  it('is whatever the stack injected — the renderer never guesses a hostname', () => {
    withOrigin('https://dev.linkix.io');

    expect(siteOrigin()).toBe('https://dev.linkix.io');
    expect(canonicalUrl('/jane')).toBe('https://dev.linkix.io/jane');
  });

  it('tolerates a trailing slash rather than emitting a doubled one', () => {
    withOrigin('https://linkix.io/');

    expect(canonicalUrl('/jane')).toBe('https://linkix.io/jane');
  });

  it('falls back to localhost only when nothing set it — i.e. the dev server', () => {
    withOrigin(undefined);

    expect(siteOrigin()).toMatch(/^http:\/\/localhost:\d+$/);
  });

  it('keeps a protocol-relative path a path, so canonical cannot change host', () => {
    withOrigin('https://linkix.io');

    for (const path of ['//evil.com', '/\\evil.com', '///evil.com']) {
      expect(new URL(canonicalUrl(path)).host).toBe('linkix.io');
    }
  });

  it('encodes what a URL requires', () => {
    withOrigin('https://linkix.io');

    expect(canonicalUrl('/jane doe')).toBe('https://linkix.io/jane%20doe');
  });
});
