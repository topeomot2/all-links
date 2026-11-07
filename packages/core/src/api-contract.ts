/**
 * The contract between the dashboard and the api Lambda. Dependency-free on
 * purpose: the dashboard imports it via `@all-links/core/api-contract`, so the
 * browser bundle never pulls in the DynamoDB client.
 */
import type { Plan, SubscriptionStatus } from './types.js';

/**
 * The header the dashboard sends its Cognito access token in, as
 * `Bearer <jwt>`.
 *
 * Not `Authorization`: the api Function URL sits behind an OAC that signs
 * every origin request, and that SigV4 signature *is* the `Authorization`
 * header — CloudFront overwrites the viewer's. Still a header, never a cookie,
 * so a dashboard session cannot reach the public cache key (ADR-0004/0006).
 */
export const AUTH_HEADER = 'x-authorization';

/** `GET /api/me` — the signed-in Account's own state, read through the API. */
export interface MeResponse {
  account: {
    accountId: string;
    email: string;
    subscription?: {
      status: SubscriptionStatus;
      plan: Plan;
      trialEnd?: string;
      currentPeriodEnd?: string;
    };
    heldUsername?: string;
  };
  page?: {
    username: string;
    displayName: string;
    bio?: string;
    themeId: string;
    active: boolean;
    suspended: boolean;
    pageViewCount: number;
  };
  links: {
    linkId: string;
    label: string;
    url: string;
    rank: string;
    clickCount: number;
  }[];
}
