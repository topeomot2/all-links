import {
  accountKey,
  linkKey,
  pageKey,
  type AccountState,
  type AccountStore,
} from '@all-links/core';
import { describe, expect, it } from 'vitest';

import { createApp, type TokenVerifier } from './app.js';

const ID = 'sub-123';

const verifier: TokenVerifier = {
  verify: (token) =>
    token === 'good' ? Promise.resolve({ sub: ID }) : Promise.reject(new Error('bad token')),
};

const state: AccountState = {
  account: {
    ...accountKey(ID),
    accountId: ID,
    email: 'jane@example.com',
    subscription: { status: 'trialing', plan: 'annual', morCustomerId: 'cus_secret' },
    heldUsername: 'jane',
  },
  page: {
    ...pageKey(ID, 'jane'),
    accountId: ID,
    username: 'jane',
    displayName: 'Jane',
    themeId: 'slate',
    active: true,
    avatarWebp: 'AAAA',
    suspendedAt: '2026-11-01T00:00:00Z',
  },
  links: [
    {
      ...linkKey(ID, 'l1', 'jane', 'a'),
      linkId: 'l1',
      label: 'Blog',
      url: 'https://example.com',
      rank: 'a',
      clickCount: 4,
    },
  ],
};

function appWith(found: AccountState | null = state) {
  const asked: string[] = [];
  const accounts: AccountStore = {
    loadAccount: (id) => {
      asked.push(id);
      return Promise.resolve(found ?? undefined);
    },
    createAccount: () => Promise.resolve(),
  };
  return { asked, app: createApp({ verifier, accounts }) };
}

const get = (app: ReturnType<typeof createApp>, path: string, headers: Record<string, string> = {}) =>
  app.request(path, { headers });

describe('authentication', () => {
  it('rejects a request with no token', async () => {
    const res = await get(appWith().app, '/api/me');

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthenticated' });
  });

  it('rejects a token the verifier does not accept', async () => {
    const res = await get(appWith().app, '/api/me', { 'x-authorization': 'Bearer forged' });

    expect(res.status).toBe(401);
  });

  it('rejects a token that is not in Bearer form', async () => {
    const res = await get(appWith().app, '/api/me', { 'x-authorization': 'good' });

    expect(res.status).toBe(401);
  });

  it('ignores the Authorization header — OAC owns it for SigV4', async () => {
    const res = await get(appWith().app, '/api/me', { authorization: 'Bearer good' });

    expect(res.status).toBe(401);
  });

  it('never lets a response be cached, even a rejection', async () => {
    const res = await get(appWith().app, '/api/me');

    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('GET /api/me', () => {
  const authed = { 'x-authorization': 'Bearer good' };

  it('reads the Account named by the token’s sub, and no other', async () => {
    const { app, asked } = appWith();
    await get(app, '/api/me', authed);

    expect(asked).toEqual([ID]);
  });

  it('returns the Account, Page and Links', async () => {
    const res = await get(appWith().app, '/api/me', authed);

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      account: {
        accountId: ID,
        email: 'jane@example.com',
        subscription: { status: 'trialing', plan: 'annual' },
        heldUsername: 'jane',
      },
      page: {
        username: 'jane',
        displayName: 'Jane',
        themeId: 'slate',
        active: true,
        suspended: true,
        pageViewCount: 0,
      },
      links: [{ linkId: 'l1', label: 'Blog', url: 'https://example.com', rank: 'a', clickCount: 4 }],
    });
  });

  it('leaks no table keys, merchant references or avatar blob', async () => {
    const body = await (await get(appWith().app, '/api/me', authed)).text();

    for (const leak of ['PK', 'GSI1PK', 'cus_secret', 'avatarWebp', 'AAAA']) {
      expect(body).not.toContain(leak);
    }
  });

  it('returns a fresh Account with no Page', async () => {
    const fresh: AccountState = {
      account: { ...accountKey(ID), accountId: ID, email: 'jane@example.com' },
      links: [],
    };
    const res = await get(appWith(fresh).app, '/api/me', authed);

    expect(await res.json()).toEqual({
      account: { accountId: ID, email: 'jane@example.com' },
      links: [],
    });
  });

  it('is a 404 when the Account item was never written', async () => {
    const res = await get(appWith(null).app, '/api/me', authed);

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'account_not_found' });
  });
});

describe('unknown routes', () => {
  it('still require a token, so they reveal nothing about the route table', async () => {
    expect((await get(appWith().app, '/api/nope')).status).toBe(401);
  });

  it('are a JSON 404 once authenticated', async () => {
    const res = await get(appWith().app, '/api/nope', { 'x-authorization': 'Bearer good' });

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
  });
});
