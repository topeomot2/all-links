/**
 * The local dev loop (ADR-0006): a thin Node server that imports the three
 * handlers directly. No Docker, no Lambda emulator — reload is milliseconds.
 *
 * It deliberately does not simulate CloudFront. Caching, TTLs and OAC are
 * exercised only against the deployed dev stack via `cdk watch`, because a
 * 60-second edge TTL is not something an emulator tells the truth about.
 *
 * Data comes from the real on-demand table in the dev stack, so this needs AWS
 * credentials and $TABLE_NAME. There is no fully offline mode.
 *
 *   npm run dev:server        # handlers on :3000
 *   npm run dev               # dashboard on :5173, proxying here
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import type { APIGatewayProxyStructuredResultV2, LambdaFunctionURLEvent } from 'aws-lambda';

import { handler as apiHandler } from '@all-links/api/handler';
import { handler as counterHandler } from '@all-links/counter/handler';
import { handler as rendererHandler } from '@all-links/renderer/handler';

type Handler = (event: LambdaFunctionURLEvent) => Promise<APIGatewayProxyStructuredResultV2>;

const PORT = Number(process.env['PORT'] ?? 3000);

/** The same split the distribution's behaviors make at the edge (ADR-0004). */
function route(path: string): { name: string; handler: Handler } {
  if (path.startsWith('/api/')) return { name: 'api', handler: apiHandler as Handler };
  if (path === '/px' || path.startsWith('/r/')) {
    return { name: 'counter', handler: counterHandler as Handler };
  }
  return { name: 'renderer', handler: rendererHandler as Handler };
}

const server = createServer((req, res) => {
  void handle(req, res).catch((err: unknown) => {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Internal Server Error');
  });
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);
  const { name, handler } = route(url.pathname);
  const started = Date.now();

  const result = await handler(toFunctionUrlEvent(req, url, await readBody(req)));
  const { statusCode, headers, body, isBase64Encoded } = normalise(result);

  res.writeHead(statusCode, headers);
  res.end(isBase64Encoded ? Buffer.from(body, 'base64') : body);

  console.log(`${req.method} ${url.pathname} → ${name} ${statusCode} ${Date.now() - started}ms`);
}

function toFunctionUrlEvent(
  req: IncomingMessage,
  url: URL,
  body: string,
): LambdaFunctionURLEvent {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(',') : value;
  }

  return {
    version: '2.0',
    routeKey: '$default',
    rawPath: url.pathname,
    rawQueryString: url.search.replace(/^\?/, ''),
    headers,
    queryStringParameters: Object.fromEntries(url.searchParams),
    requestContext: {
      accountId: 'anonymous',
      apiId: 'local',
      domainName: `localhost:${PORT}`,
      domainPrefix: 'localhost',
      http: {
        method: req.method ?? 'GET',
        path: url.pathname,
        protocol: 'HTTP/1.1',
        sourceIp: req.socket.remoteAddress ?? '127.0.0.1',
        userAgent: headers['user-agent'] ?? '',
      },
      requestId: crypto.randomUUID(),
      routeKey: '$default',
      stage: '$default',
      time: new Date().toISOString(),
      timeEpoch: Date.now(),
    },
    body: body === '' ? undefined : body,
    isBase64Encoded: false,
  } as LambdaFunctionURLEvent;
}

function normalise(result: APIGatewayProxyStructuredResultV2): {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
  isBase64Encoded: boolean;
} {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(result.headers ?? {})) {
    headers[name] = String(value);
  }

  return {
    statusCode: result.statusCode ?? 200,
    headers,
    body: result.body ?? '',
    isBase64Encoded: result.isBase64Encoded ?? false,
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  if (req.method === 'GET' || req.method === 'HEAD') return '';

  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

server.listen(PORT, () => {
  console.log(`all-links handlers on http://localhost:${PORT}`);
  console.log(`  /api/*      → api`);
  console.log(`  /px, /r/*   → counter`);
  console.log(`  everything  → renderer`);
  if (!process.env['TABLE_NAME']) {
    console.log('\n  TABLE_NAME is unset. Nothing reads DynamoDB yet (T1), but T2 onwards');
    console.log("  needs it pointed at the dev stack's table, with AWS credentials.");
  }
});
