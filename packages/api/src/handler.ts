import type { APIGatewayProxyStructuredResultV2, LambdaFunctionURLEvent } from 'aws-lambda';

/**
 * The `/api/*` Lambda: CRUD and billing webhooks, routed with Hono behind a
 * Function URL + OAC (ADR-0006).
 *
 * T1 deploys nothing here — the package exists so `core`, the local dev loop
 * and the workspace layout are in place for T7 onwards. It answers 501 rather
 * than 404 so a misrouted request is unambiguous.
 */
export async function handler(
  _event: LambdaFunctionURLEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  return {
    statusCode: 501,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
    body: JSON.stringify({ error: 'not_implemented' }),
  };
}
