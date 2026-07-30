import { describe, expect, expectTypeOf, it } from 'vitest';

import { GSI1_PROJECTED_ATTRIBUTES, type AccountItem, type PageItem } from './index.js';

describe('the private/public item split', () => {
  // Compile-time: caught by `npm run typecheck`, which includes test files.
  it('gives the Page a GSI1 partition and the Account none', () => {
    expectTypeOf<PageItem>().toHaveProperty('GSI1PK');
    expectTypeOf<AccountItem>().not.toHaveProperty('GSI1PK');
  });

  it('projects no private attribute into GSI1', () => {
    const projected: readonly string[] = GSI1_PROJECTED_ATTRIBUTES;

    for (const priv of ['email', 'subscription', 'heldUsername', 'lastRenamedAt']) {
      expect(projected).not.toContain(priv);
    }
  });

  it('projects everything the public render and the visibility gate need', () => {
    const projected: readonly string[] = GSI1_PROJECTED_ATTRIBUTES;

    for (const pub of ['active', 'suspendedAt', 'accountId', 'url', 'rank', 'label']) {
      expect(projected).toContain(pub);
    }
  });
});
