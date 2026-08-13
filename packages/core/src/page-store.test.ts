import { QueryCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';

import { linkKey, pageKey } from './keys.js';
import { createPageStore, type QueryClient } from './page-store.js';
import type { LinkItem, PageItem } from './types.js';

const ACCOUNT = 'acct-1';

const page = (overrides: Partial<PageItem> = {}): PageItem => ({
  ...pageKey(ACCOUNT, 'jane'),
  accountId: ACCOUNT,
  username: 'jane',
  displayName: 'Jane',
  themeId: 'slate',
  active: true,
  ...overrides,
});

const link = (linkId: string, rank: string, label: string): LinkItem => ({
  ...linkKey(ACCOUNT, linkId, 'jane', rank),
  linkId,
  label,
  url: `https://example.com/${linkId}`,
  rank,
});

/** Records what was asked of DynamoDB, and answers with fixed items. */
function fakeClient(items: object[]): QueryClient & { sent: QueryCommand[] } {
  const sent: QueryCommand[] = [];
  return {
    sent,
    send(command: QueryCommand): Promise<QueryCommandOutput> {
      sent.push(command);
      return Promise.resolve({ Items: items } as unknown as QueryCommandOutput);
    },
  };
}

const storeOf = (items: object[]) => {
  const client = fakeClient(items);
  return { client, store: createPageStore({ client, tableName: 'the-table' }) };
};

describe('the public read path', () => {
  it('is one GSI1 query on the username partition (ADR-0003)', async () => {
    const { client, store } = storeOf([page()]);

    await store.lookupPage('jane');

    expect(client.sent).toHaveLength(1);
    const { input } = client.sent[0]!;
    expect(input.TableName).toBe('the-table');
    expect(input.IndexName).toBe('GSI1');
    expect(input.ExpressionAttributeValues?.[':pk']).toBe('USERNAME#jane');
    // Ascending, so the Page (GSI1SK `0`) arrives before its Links (`1#<rank>`).
    expect(input.ScanIndexForward).not.toBe(false);
  });

  it('canonicalises the username, so `/Jane` reaches the same partition', async () => {
    const { client, store } = storeOf([page()]);

    await store.lookupPage('JANE');

    expect(client.sent[0]!.input.ExpressionAttributeValues?.[':pk']).toBe('USERNAME#jane');
  });

  it('returns the Page and its Links in rank order', async () => {
    const { store } = storeOf([page(), link('l1', 'a', 'One'), link('l2', 'b', 'Two')]);

    const result = await store.lookupPage('jane');

    expect(result.kind).toBe('visible');
    if (result.kind !== 'visible') return;
    expect(result.page.displayName).toBe('Jane');
    expect(result.links.map((l) => l.label)).toEqual(['One', 'Two']);
  });

  it('reports an unclaimed username as absent, not as an empty Page', async () => {
    const { store } = storeOf([]);

    expect((await store.lookupPage('nobody')).kind).toBe('absent');
  });
});

describe('the visibility gate — active && !suspendedAt (spec §4)', () => {
  it('hides a lapsed Page', async () => {
    const { store } = storeOf([page({ active: false })]);

    expect((await store.lookupPage('jane')).kind).toBe('hidden');
  });

  it('hides a suspended Page even though its Subscription is active', async () => {
    // The regression the gate exists to prevent: checking `active` alone would
    // serve this Page, and a suspension is precisely what must not be served.
    const { store } = storeOf([page({ active: true, suspendedAt: '2026-07-01T00:00:00Z' })]);

    expect((await store.lookupPage('jane')).kind).toBe('hidden');
  });

  it('hides a Page that is both lapsed and suspended', async () => {
    const { store } = storeOf([page({ active: false, suspendedAt: '2026-07-01T00:00:00Z' })]);

    expect((await store.lookupPage('jane')).kind).toBe('hidden');
  });

  it('withholds the Links of a hidden Page — the gate is not cosmetic', async () => {
    const { store } = storeOf([page({ active: false }), link('l1', 'a', 'One')]);

    expect(await store.lookupPage('jane')).toEqual({ kind: 'hidden' });
  });

  it('costs no extra read — the gate runs on the query that already happened', async () => {
    const { client, store } = storeOf([page({ active: false })]);

    await store.lookupPage('jane');

    expect(client.sent).toHaveLength(1);
  });
});
