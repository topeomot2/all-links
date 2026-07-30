// `LambdaFunctionURLResult` also admits a bare string; the structured shape is
// the only one these handlers return.
import type { APIGatewayProxyStructuredResultV2, LambdaFunctionURLEvent } from 'aws-lambda';

import type { RenderRequest } from './http.js';
import { handleRequest } from './render.js';

/**
 * Lambda Function URL adapter (ADR-0006). The Function URL is `AWS_IAM` and
 * reachable only through CloudFront via OAC, so this sees requests that have
 * already passed the edge.
 */
export async function handler(
  event: LambdaFunctionURLEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const res = handleRequest(toRenderRequest(event));

  return {
    statusCode: res.status,
    headers: res.headers,
    body: res.body,
    isBase64Encoded: res.isBase64Encoded ?? false,
  };
}

export function toRenderRequest(event: LambdaFunctionURLEvent): RenderRequest {
  const headers: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    headers[name.toLowerCase()] = value;
  }

  return {
    method: event.requestContext.http.method,
    path: decodePath(event.rawPath ?? '/'),
    query: { ...event.queryStringParameters },
    headers,
  };
}

/**
 * CloudFront forwards the path percent-encoded. Usernames can never contain a
 * `%` (ADR-0007), so a decoded path either matches a route or misses — but a
 * malformed escape must not take the request down with it.
 */
function decodePath(rawPath: string): string {
  try {
    return decodeURIComponent(rawPath);
  } catch {
    return rawPath;
  }
}
