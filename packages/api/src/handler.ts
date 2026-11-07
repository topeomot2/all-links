import { createDynamoAccountStore } from '@all-links/core';
import type { APIGatewayProxyStructuredResultV2, LambdaFunctionURLEvent } from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { handle } from 'hono/aws-lambda';

import { createApp } from './app.js';
import { required } from './env.js';

/**
 * The `/api/*` Lambda: Hono over a Function URL, reachable only through
 * CloudFront via OAC (ADR-0006).
 */
export async function handler(
  event: LambdaFunctionURLEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  // A Function URL event is payload format 2.0 — the shape Hono's API Gateway
  // v2 adapter reads — it is just typed separately in `@types/aws-lambda`.
  return (await lambda()(event as never)) as APIGatewayProxyStructuredResultV2;
}

let cached: ReturnType<typeof handle> | undefined;

/**
 * Built once per container: the verifier caches Cognito's JWKS in memory, and
 * the Document client keeps its connection pool, across warm invocations.
 * Lazy so importing this file — from the dev server or a test — needs no env.
 */
function lambda(): ReturnType<typeof handle> {
  cached ??= handle(
    createApp({
      verifier: CognitoJwtVerifier.create({
        userPoolId: required('USER_POOL_ID'),
        clientId: required('USER_POOL_CLIENT_ID'),
        tokenUse: 'access',
      }),
      accounts: createDynamoAccountStore(required('TABLE_NAME')),
    }),
  );

  return cached;
}
