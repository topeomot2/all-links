import type { APIGatewayProxyStructuredResultV2, LambdaFunctionURLEvent } from 'aws-lambda';

/**
 * The counting Lambda: `/px` page views and `/r/*` click redirects (ADR-0008),
 * behind a Function URL + OAC.
 *
 * T1 deploys nothing here — the package exists so the layout and the local dev
 * loop are in place for T5. It answers 501 rather than 404 so a misrouted
 * request is unambiguous.
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
