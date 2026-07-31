/**
 * The public read path: `Query GSI1 where GSI1PK = USERNAME#<name>` → the Page
 * (`GSI1SK=0`) then its Links in rank order. One query serves a whole render
 * (ADR-0003).
 *
 * The visibility gate lives *inside* the lookup rather than beside it. `active
 * && !suspendedAt` has to hold on every public surface — the Page, `/i/*`,
 * `/px`, `/r/*` — and a helper each of them must remember to call is exactly
 * the shape that eventually serves a suspended Page. Returning a hidden Page
 * as `{ kind: 'hidden' }`, with no attributes attached, makes forgetting the
 * check unrepresentable.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';

import { usernameIndexKey } from './keys.js';
import type { LinkItem, PageItem } from './types.js';

/** The GSI1 index name, fixed by `infra`. */
export const USERNAME_INDEX = 'GSI1';

export type PageLookup =
  | { kind: 'visible'; page: PageItem; links: LinkItem[] }
  /** The Page exists but is lapsed, suspended, or both. Deliberately carries nothing. */
  | { kind: 'hidden' }
  /** No Page under this username — unclaimed, renamed away, or erased. */
  | { kind: 'absent' };

export interface PageStore {
  lookupPage(username: string): Promise<PageLookup>;
}

/** The slice of the Document client this module uses, so tests need no SDK mock. */
export interface QueryClient {
  send(command: QueryCommand): Promise<QueryCommandOutput>;
}

export interface PageStoreOptions {
  client: QueryClient;
  tableName: string;
}

export function createPageStore({ client, tableName }: PageStoreOptions): PageStore {
  return {
    async lookupPage(username: string): Promise<PageLookup> {
      const result = await client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: USERNAME_INDEX,
          KeyConditionExpression: 'GSI1PK = :pk',
          ExpressionAttributeValues: { ':pk': usernameIndexKey(username).GSI1PK },
          // Ascending: the Page sorts at `0`, its Links at `1#<rank>`, so the
          // index order *is* the render order.
          ScanIndexForward: true,
        }),
      );

      return toPageLookup(result.Items ?? []);
    },
  };
}

/** What DynamoDB actually returns: an untyped attribute bag per item. */
type Attributes = Record<string, unknown>;

/**
 * Sorts one query's items into the answer the public read path needs.
 *
 * The casts here are the one place the stored shape is asserted. Every item in
 * this partition was written through `core`'s own key builders, and there is
 * nothing useful a public render could do with a malformed one anyway — so the
 * trust boundary is drawn once, and the rest of the read path works in domain
 * types.
 */
function toPageLookup(items: Attributes[]): PageLookup {
  const page = items.find(isPage) as PageItem | undefined;
  if (!page) return { kind: 'absent' };
  if (!isPubliclyVisible(page)) return { kind: 'hidden' };

  return { kind: 'visible', page, links: items.filter(isLink) as unknown as LinkItem[] };
}

/**
 * `active` is a pure function of Subscription status; `suspendedAt` is
 * moderation state and orthogonal to it. Both arrive in the query that already
 * happened, so this costs no extra read — and checking `active` alone would
 * serve suspended Pages (spec §4).
 */
function isPubliclyVisible(page: PageItem): boolean {
  return page.active === true && !page.suspendedAt;
}

const isPage = (item: Attributes): boolean => item['SK'] === 'PAGE';

const isLink = (item: Attributes): boolean =>
  typeof item['SK'] === 'string' && item['SK'].startsWith('LINK#');

/**
 * The store the Lambdas use. `DynamoDBDocumentClient` is created once per
 * container so its connection pool survives a warm invocation.
 */
export function createDynamoPageStore(tableName: string): PageStore {
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
    marshallOptions: { removeUndefinedValues: true },
  });

  return createPageStore({ client, tableName });
}
