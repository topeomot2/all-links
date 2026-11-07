import { AUTH_HEADER, type AccountState, type AccountStore, type MeResponse } from '@all-links/core';
import { Hono } from 'hono';

/**
 * The `/api/*` routes (ADR-0006). Built from injected dependencies so tests
 * exercise real routing and real auth decisions without AWS.
 */

/** What the api needs from a JWT verifier — `aws-jwt-verify`'s shape, narrowed. */
export interface TokenVerifier {
  /** Resolves with the token's claims, or rejects if it is not valid. */
  verify(token: string): Promise<{ sub: string }>;
}

export interface ApiDeps {
  verifier: TokenVerifier;
  accounts: AccountStore;
}

type Env = { Variables: { accountId: string } };

export function createApp({ verifier, accounts }: ApiDeps): Hono<Env> {
  const app = new Hono<Env>().basePath('/api');

  // Every api answer is per-Account and must never be cached anywhere — the
  // behavior is CachingDisabled too, but the origin says so as well.
  app.use('*', async (c, next) => {
    await next();
    c.header('cache-control', 'no-store');
  });

  // The JWT is verified here, in process, against Cognito's cached JWKS — no
  // API Gateway authorizer (ADR-0006). The `sub` it carries is the accountId.
  app.use('*', async (c, next) => {
    const token = bearer(c.req.header(AUTH_HEADER));
    if (!token) return c.json({ error: 'unauthenticated' }, 401);

    let sub: string;
    try {
      ({ sub } = await verifier.verify(token));
    } catch {
      return c.json({ error: 'unauthenticated' }, 401);
    }

    c.set('accountId', sub);
    await next();
  });

  app.get('/me', async (c) => {
    const state = await accounts.loadAccount(c.get('accountId'));
    // Confirmed in Cognito but no Account item: the post-confirmation trigger
    // failed. Not something the dashboard can fix by retrying the call.
    if (!state) return c.json({ error: 'account_not_found' }, 404);

    return c.json(toMeResponse(state));
  });

  app.notFound((c) => c.json({ error: 'not_found' }, 404));
  app.onError((err, c) => {
    console.error('api error', err);
    return c.json({ error: 'internal' }, 500);
  });

  return app;
}

function bearer(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return match?.[1];
}

/**
 * An explicit view, not the stored items: table keys, `GSI1*` and the avatar
 * blob have no business in a JSON response, and a new private attribute must
 * be added here on purpose before it leaves the Lambda.
 */
export function toMeResponse({ account, page, links }: AccountState): MeResponse {
  const sub = account.subscription;

  return {
    account: {
      accountId: account.accountId,
      email: account.email,
      ...(sub
        ? {
            subscription: {
              status: sub.status,
              plan: sub.plan,
              ...(sub.trialEnd ? { trialEnd: sub.trialEnd } : {}),
              ...(sub.currentPeriodEnd ? { currentPeriodEnd: sub.currentPeriodEnd } : {}),
            },
          }
        : {}),
      ...(account.heldUsername ? { heldUsername: account.heldUsername } : {}),
    },
    ...(page
      ? {
          page: {
            username: page.username,
            displayName: page.displayName,
            ...(page.bio ? { bio: page.bio } : {}),
            themeId: page.themeId,
            active: page.active,
            suspended: Boolean(page.suspendedAt),
            pageViewCount: page.pageViewCount ?? 0,
          },
        }
      : {}),
    links: links.map((l) => ({
      linkId: l.linkId,
      label: l.label,
      url: l.url,
      rank: l.rank,
      clickCount: l.clickCount ?? 0,
    })),
  };
}
