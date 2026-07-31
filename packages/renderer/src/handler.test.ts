import type { LambdaFunctionURLEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import { handler, toRenderRequest } from './handler.js';

const event = (overrides: Partial<LambdaFunctionURLEvent> = {}): LambdaFunctionURLEvent =>
  ({
    version: '2.0',
    rawPath: '/jane',
    rawQueryString: '',
    headers: { 'user-agent': 'probe', Host: 'abc.lambda-url.us-east-1.on.aws' },
    requestContext: {
      http: { method: 'GET', path: '/jane', protocol: 'HTTP/1.1', sourceIp: '1.2.3.4' },
    },
    isBase64Encoded: false,
    ...overrides,
  }) as LambdaFunctionURLEvent;

describe('the Function URL adapter', () => {
  it('reads the method and path out of the event', () => {
    const req = toRenderRequest(event({ rawPath: '/terms' }));

    expect(req.method).toBe('GET');
    expect(req.path).toBe('/terms');
  });

  it('lowercases header names so handlers never guess at casing', () => {
    const req = toRenderRequest(event());

    expect(req.headers['host']).toBe('abc.lambda-url.us-east-1.on.aws');
  });

  it('carries the query string through', () => {
    const req = toRenderRequest(
      event({ rawQueryString: 'u=jane', queryStringParameters: { u: 'jane' } }),
    );

    expect(req.query['u']).toBe('jane');
  });

  it('decodes the path, since CloudFront hands the origin a raw one', () => {
    expect(toRenderRequest(event({ rawPath: '/jane%20doe' })).path).toBe('/jane doe');
  });

  it('leaves a malformed escape alone rather than throwing', () => {
    expect(toRenderRequest(event({ rawPath: '/%E0%A4%A' })).path).toBe('/%E0%A4%A');
  });

  it('returns a Function URL result the runtime can serialise', async () => {
    process.env['TABLE_NAME'] = 'the-table';

    // A path that is not a Username is answered above the table, so this
    // exercises the whole adapter without reaching DynamoDB.
    const res = await handler(event({ rawPath: '/deep/unknown/path' }));

    expect(res.statusCode).toBe(404);
    expect(res.headers?.['cache-control']).toBe('public, s-maxage=60, max-age=0');
    expect(res.body ?? '').toContain('<!DOCTYPE html>');
    expect(res.isBase64Encoded).toBe(false);
  });
});
