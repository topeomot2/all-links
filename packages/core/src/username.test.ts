import { describe, expect, it } from 'vitest';

import { canonicalUsername, isReservedUsername, isValidUsername, RESERVED } from './username.js';

describe('the username shape (ADR-0007)', () => {
  it('accepts alphanumeric runs joined by single separators, 3–30 chars', () => {
    for (const name of ['jane', 'jane-doe', 'jane_doe', 'j4n3', 'a1b', 'a'.repeat(30)]) {
      expect(isValidUsername(name), name).toBe(true);
    }
  });

  it('rejects a separator that leads, trails or doubles', () => {
    for (const name of ['-jane', 'jane-', '_jane', 'jane__doe', 'jane--doe', 'jane-_doe']) {
      expect(isValidUsername(name), name).toBe(false);
    }
  });

  it('rejects anything outside 3–30 characters', () => {
    expect(isValidUsername('ab')).toBe(false);
    expect(isValidUsername('a'.repeat(31))).toBe(false);
    expect(isValidUsername('')).toBe(false);
  });

  it('rejects characters that could ever need percent-encoding in a Page URL', () => {
    for (const name of ['jane doe', 'jane.doe', 'jane/doe', 'jane%20', 'jané', 'jane?x']) {
      expect(isValidUsername(name), name).toBe(false);
    }
  });

  it('treats uppercase as un-canonical rather than as a different name', () => {
    // Typed uppercase is silently lowercased on the claim path, so the literal
    // `Jane` is not itself a valid stored name — its canonical form is.
    expect(isValidUsername('Jane')).toBe(false);
    expect(canonicalUsername('JaneDoe')).toBe('janedoe');
    expect(isValidUsername(canonicalUsername('Jane-Doe'))).toBe(true);
  });
});

describe('the reserved set (ADR-0007, amended by ADR-0013)', () => {
  it('reserves the routing and marketing namespace', () => {
    for (const name of ['api', 'app', 'about', 'blog', 'docs', 'help', 'status', 'admin']) {
      expect(isReservedUsername(name), name).toBe(true);
    }
  });

  it('reserves authority and impersonation words', () => {
    for (const name of ['support', 'billing', 'security', 'abuse', 'legal', 'www', 'mail']) {
      expect(isReservedUsername(name), name).toBe(true);
    }
  });

  it('reserves the brand and its near-variants', () => {
    for (const name of ['all-links', 'alllinks', 'all_links', 'all-link']) {
      expect(isReservedUsername(name), name).toBe(true);
    }
  });

  it('reserves the names that will gain a static route in T3', () => {
    // ADR-0013 derives these from `STATIC_ROUTES` once it exists. Until then
    // they are listed, because `/terms` must not offer to sell the name.
    for (const name of ['terms', 'privacy', 'login', 'signup', 'pricing']) {
      expect(isReservedUsername(name), name).toBe(true);
    }
  });

  it('lets an ordinary handle through', () => {
    for (const name of ['jane', 'jane-doe', 'linkstack', 'appleton']) {
      expect(isReservedUsername(name), name).toBe(false);
    }
  });

  it('canonicalises before testing, so `API` is not a way past the denylist', () => {
    expect(isReservedUsername('API')).toBe(true);
    expect(isReservedUsername('Support')).toBe(true);
  });

  it('holds only canonical names, so no entry can be unreachable', () => {
    for (const name of RESERVED) {
      expect(canonicalUsername(name), name).toBe(name);
    }
  });
});
