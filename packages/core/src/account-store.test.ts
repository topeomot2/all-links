import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';

import { createAccountStore, type AccountClient } from './account-store.js';
import { accountKey, linkKey, pageKey } from './keys.js';

const ID = 'sub-123';

const account = { ...accountKey(ID), accountId: ID, email: 'jane@example.com' };
const page = {
  ...pageKey(ID, 'jane'),
  accountId: ID,
  username: 'jane',
  displayName: 'Jane',
  themeId: 'slate',
  active: true,
};
const link = (linkId: string, rank: string) => ({
  ...linkKey(ID, linkId, 'jane', rank),
  linkId,
  label: linkId,
  url: 'https://example.com',
  rank,
});

type Sent = QueryCommand | PutCommand;

function fakeClient(
  pages: object[][],
  putError?: Error,
): AccountClient & { sent: Sent[] } {
  const sent: Sent[] = [];
  let call = 0;
  return {
    sent,
    send(command: Sent) {
      sent.push(command);
      if (command instanceof PutCommand) {
        return putError ? Promise.reject(putError) : Promise.resolve({});
      }
      const items = pages[call] ?? [];
      call += 1;
      const more = call < pages.length;
      return Promise.resolve({
        Items: items,
        ...(more ? { LastEvaluatedKey: { PK: 'x', SK: 'y' } } : {}),
      });
    },
  } as AccountClient & { sent: Sent[] };
}

describe('loading an Account', () => {
  it('is one query on the Account partition — the dashboard access pattern', async () => {
    const client = fakeClient([[account]]);
    await createAccountStore({ client, tableName: 't' }).loadAccount(ID);

    expect(client.sent).toHaveLength(1);
    const input = (client.sent[0] as QueryCommand).input;
    expect(input.TableName).toBe('t');
    expect(input.IndexName).toBeUndefined();
    expect(input.KeyConditionExpression).toBe('PK = :pk');
    expect(input.ExpressionAttributeValues).toEqual({ ':pk': `ACCOUNT#${ID}` });
  });

  it('is undefined when no Account item exists', async () => {
    const store = createAccountStore({ client: fakeClient([[]]), tableName: 't' });

    expect(await store.loadAccount(ID)).toBeUndefined();
  });

  it('returns a fresh Account with no Page and no Links', async () => {
    const store = createAccountStore({ client: fakeClient([[account]]), tableName: 't' });

    expect(await store.loadAccount(ID)).toEqual({ account, links: [] });
  });

  it('returns the Page and its Links in rank order, not SK order', async () => {
    const items = [account, link('a', 'm'), link('b', 'c'), page];
    const store = createAccountStore({ client: fakeClient([items]), tableName: 't' });

    const state = await store.loadAccount(ID);

    expect(state?.page).toEqual(page);
    expect(state?.links.map((l) => l.linkId)).toEqual(['b', 'a']);
  });

  it('follows pagination rather than dropping Links past 1 MB', async () => {
    const client = fakeClient([[account, link('a', 'a')], [link('b', 'b')]]);
    const state = await createAccountStore({ client, tableName: 't' }).loadAccount(ID);

    expect(client.sent).toHaveLength(2);
    expect(state?.links).toHaveLength(2);
  });
});

describe('creating an Account', () => {
  it('writes an inactive Account with no Subscription, keyed by the Cognito sub', async () => {
    const client = fakeClient([]);
    await createAccountStore({ client, tableName: 't' }).createAccount({
      accountId: ID,
      email: 'jane@example.com',
    });

    const input = (client.sent[0] as PutCommand).input;
    expect(input.Item).toEqual({
      PK: `ACCOUNT#${ID}`,
      SK: 'ACCOUNT',
      accountId: ID,
      email: 'jane@example.com',
    });
    expect(input.Item).not.toHaveProperty('subscription');
    expect(input.Item).not.toHaveProperty('GSI1PK');
  });

  it('never overwrites an existing Account', async () => {
    const client = fakeClient([]);
    await createAccountStore({ client, tableName: 't' }).createAccount({
      accountId: ID,
      email: 'jane@example.com',
    });

    expect((client.sent[0] as PutCommand).input.ConditionExpression).toBe(
      'attribute_not_exists(PK)',
    );
  });

  it('treats an existing Account as success, so a retried trigger is harmless', async () => {
    const exists = Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' });
    const store = createAccountStore({ client: fakeClient([], exists), tableName: 't' });

    await expect(store.createAccount({ accountId: ID, email: 'a@b.c' })).resolves.toBeUndefined();
  });

  it('surfaces any other failure, so Cognito retries the trigger', async () => {
    const store = createAccountStore({
      client: fakeClient([], new Error('throttled')),
      tableName: 't',
    });

    await expect(store.createAccount({ accountId: ID, email: 'a@b.c' })).rejects.toThrow(
      'throttled',
    );
  });
});
