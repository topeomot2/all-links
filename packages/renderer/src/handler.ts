// `LambdaFunctionURLResult` also admits a bare string; the structured shape is
// the only one these handlers return.
import { createDynamoPageStore, DEFAULT_SITE_DOMAIN } from '@all-links/core';
import type { APIGatewayProxyStructuredResultV2, LambdaFunctionURLEvent } from 'aws-lambda';

import { serverError, type RenderRequest } from './http.js';
import { handleRequest, type RenderDeps } from './render.js';

/**
 * Lambda Function URL adapter (ADR-0006). The Function URL is `AWS_IAM` and
 * reachable only through CloudFront via OAC, so this sees requests that have
 * already passed the edge.
 */
export async function handler(
  event: LambdaFunctionURLEvent,
): Promise<APIGatewayProxyStructuredResultV2> {
  const res = await handleRequest(toRenderRequest(event), deps()).catch((err: unknown) => {
    // The renderer's only dependency is one DynamoDB query. If it fails there
    // is no answer to give — and `serverError` is `no-store`, so a blip cannot
    // be cached at the edge for the next 60 seconds.
    console.error('render failed', err);
    return serverError();
  });

  return {
    statusCode: res.status,
    headers: res.headers,
    body: res.body,
    isBase64Encoded: res.isBase64Encoded ?? false,
  };
}

let cached: RenderDeps | undefined;

/**
 * Built once per container, not once per invocation: the Document client's
 * connection pool is the thing worth keeping across a warm invocation.
 *
 * Lazy rather than module-level, so importing this file — from the dev server,
 * or from a test — does not require the environment to be configured.
 */
function deps(): RenderDeps {
  cached ??= {
    store: createDynamoPageStore(required('TABLE_NAME')),
    // `infra` always sets this; the fallback is for the local dev server.
    siteDomain: process.env['SITE_DOMAIN'] ?? DEFAULT_SITE_DOMAIN,
  };

  return cached;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set — the renderer cannot read the table without it`);

  return value;
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
