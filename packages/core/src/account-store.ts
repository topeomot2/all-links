/**
 * The private read/write path for an Account's own item collection (ADR-0003).
 *
 * `Query PK=ACCOUNT#<id>` returns the Account, its Page (if one exists yet)
 * and every Link in one round trip — the dashboard's single access pattern.
 * The Account item is the only one here the public index never sees.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  type PutCommandOutput,
  type QueryCommandOutput,
} from '@aws-sdk/lib-dynamodb';

import { accountKey } from './keys.js';
import type { AccountItem, LinkItem, PageItem } from './types.js';

export interface AccountState {
  account: AccountItem;
  /** Absent until the claim and the billing webhook have both landed (spec §6.1). */
  page?: PageItem;
  /** In rank order — the order the public Page renders them. */
  links: LinkItem[];
}

export interface AccountStore {
  /** `undefined` when no Account item exists for this id. */
  loadAccount(accountId: string): Promise<AccountState | undefined>;
  /**
   * Writes a fresh Account: inactive, no Subscription (ADR-0005). Idempotent —
   * a retried trigger finds the item already there and leaves it alone, so a
   * Subscription written in between can never be clobbered.
   */
  createAccount(input: { accountId: string; email: string }): Promise<void>;
}

/** The slice of the Document client this module uses, so tests need no SDK mock. */
export interface AccountClient {
  send(command: QueryCommand): Promise<QueryCommandOutput>;
  send(command: PutCommand): Promise<PutCommandOutput>;
}

export interface AccountStoreOptions {
  client: AccountClient;
  tableName: string;
}

export function createAccountStore({ client, tableName }: AccountStoreOptions): AccountStore {
  return {
    async loadAccount(accountId) {
      const items: Attributes[] = [];
      let startKey: Record<string, unknown> | undefined;

      // One query; pagination only matters past 1 MB, which an avatar blob
      // plus a few hundred Links could in principle reach.
      do {
        const result: QueryCommandOutput = await client.send(
          new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: 'PK = :pk',
            ExpressionAttributeValues: { ':pk': accountKey(accountId).PK },
            ExclusiveStartKey: startKey,
          }),
        );
        items.push(...(result.Items ?? []));
        startKey = result.LastEvaluatedKey;
      } while (startKey);

      return toAccountState(items);
    },

    async createAccount({ accountId, email }) {
      const item: AccountItem = { ...accountKey(accountId), accountId, email };

      try {
        await client.send(
          new PutCommand({
            TableName: tableName,
            Item: item,
            ConditionExpression: 'attribute_not_exists(PK)',
          }),
        );
      } catch (err) {
        if (isConditionalCheckFailed(err)) return;
        throw err;
      }
    },
  };
}

type Attributes = Record<string, unknown>;

/**
 * Sorts one partition's items into domain types. As in `page-store`, every
 * item here was written through `core`'s key builders, so the casts are the
 * single place the stored shape is asserted.
 */
function toAccountState(items: Attributes[]): AccountState | undefined {
  const account = items.find((i) => i['SK'] === 'ACCOUNT') as AccountItem | undefined;
  if (!account) return undefined;

  const page = items.find((i) => i['SK'] === 'PAGE') as PageItem | undefined;
  // The base table sorts by SK (`LINK#<ulid>`), not rank — so order here.
  const links = (items.filter(isLink) as unknown as LinkItem[]).sort((a, b) =>
    a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : 0,
  );

  return { account, ...(page ? { page } : {}), links };
}

const isLink = (item: Attributes): boolean =>
  typeof item['SK'] === 'string' && item['SK'].startsWith('LINK#');

function isConditionalCheckFailed(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'ConditionalCheckFailedException'
  );
}

export function createDynamoAccountStore(tableName: string): AccountStore {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });

  return createAccountStore({ client: client as AccountClient, tableName });
}
