import type { PageStore } from '@all-links/core';
import { canonicalUsername, isReservedUsername, isValidUsername } from '@all-links/core';
import type { VNode } from 'preact';
import { render } from 'preact-render-to-string';

import { abuseEmail, canonicalUrl } from './config.js';
import {
  htmlResponse,
  methodNotAllowed,
  PAGE_CACHE_CONTROL,
  type RenderRequest,
  type RenderResponse,
} from './http.js';
import { NotFoundDocument, type NotFoundReason } from './pages/not-found.js';
import { PageDocument } from './pages/page.js';

const DOCTYPE = '<!DOCTYPE html>';

export interface RenderDeps {
  store: PageStore;
}

/**
 * The renderer's single entry point.
 *
 * The order is the one ADR-0013 fixes: the static route table from `core` (T3)
 * will sit directly above the Username lookup below, so a Static route always
 * wins over a Page. Everything here is either a Page or a reason there isn't
 * one — and every one of those reasons is a 404 at the Page's own freshness,
 * so a freshly claimed Username goes live within 60 seconds.
 */
export async function handleRequest(req: RenderRequest, deps: RenderDeps): Promise<RenderResponse> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return methodNotAllowed();
  }

  const res = await route(req, deps);

  // A HEAD is its GET minus the body: same status, same headers, so a probe
  // against the deployed stack reports the caching a browser would get.
  return req.method === 'HEAD' ? { ...res, body: '' } : res;
}

async function route(req: RenderRequest, deps: RenderDeps): Promise<RenderResponse> {
  const username = usernameFromPath(req.path);

  // Not a Username at all — a multi-segment path, or one no Account could ever
  // claim. Offering to sell it would be a lie.
  if (username === undefined) return notFound('unknown');

  // A Reserved name can never have a Page, so this answers without a read.
  if (isReservedUsername(username)) return notFound('reserved', username);

  const lookup = await deps.store.lookupPage(username);

  switch (lookup.kind) {
    case 'visible':
      return respond(
        <PageDocument
          page={lookup.page}
          links={lookup.links}
          abuseEmail={abuseEmail()}
          // Built from the *stored* Username, not the requested path, so the
          // one canonical URL is the same string whether a visitor arrived at
          // `/Jane`, `/jane/` or `/jane`.
          canonical={canonicalUrl(`/${lookup.page.username}`)}
        />,
      );
    case 'hidden':
      return notFound('inactive', username);
    case 'absent':
      return notFound('unclaimed', username);
  }
}

/**
 * The Username a path addresses, or `undefined` if it addresses none.
 *
 * One trailing slash is stripped, so `/jane/` resolves — a Username can never
 * end in a separator, so the strip cannot change which name is meant.
 *
 * Case is canonicalised, for the same reason `core`'s key builders
 * canonicalise: Usernames are lowercase-canonical (ADR-0007), so `/Jane` and
 * `/jane` are one handle. ADR-0013 flagged the un-canonicalised path as a
 * one-line fix owed to whoever owns username casing, and left `/API` answering
 * *"the name API is available"* — which is exactly the falsehood its reserved
 * check exists to stop. This is that line.
 */
function usernameFromPath(path: string): string | undefined {
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  if (!trimmed.startsWith('/')) return undefined;

  const username = canonicalUsername(trimmed.slice(1));
  return isValidUsername(username) ? username : undefined;
}

function notFound(reason: NotFoundReason, username?: string): RenderResponse {
  return respond(<NotFoundDocument reason={reason} username={username} />, 404);
}

/** Every document the renderer emits leaves through here, at the Page's own freshness. */
function respond(node: VNode, status = 200): RenderResponse {
  return htmlResponse(DOCTYPE + render(node), PAGE_CACHE_CONTROL, status);
}
