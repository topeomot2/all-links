import { render } from 'preact-render-to-string';

import { canonicalUrl } from './config.js';
import {
  htmlResponse,
  methodNotAllowed,
  PAGE_CACHE_CONTROL,
  type RenderRequest,
  type RenderResponse,
} from './http.js';
import { Skeleton } from './pages/skeleton.js';

const DOCTYPE = '<!DOCTYPE html>';

/**
 * The renderer's single entry point.
 *
 * Later slices insert their work here in the order ADR-0013 fixes: the static
 * route table from `core` is checked first (T3), then the GSI1 username lookup
 * (T2). Today every path falls through to the skeleton document.
 */
export function handleRequest(req: RenderRequest): RenderResponse {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return methodNotAllowed();
  }

  const res = htmlResponse(renderSkeleton(req.path), PAGE_CACHE_CONTROL);

  // A HEAD is its GET minus the body: same status, same headers, so a probe
  // against the deployed stack reports the caching a browser would get.
  return req.method === 'HEAD' ? { ...res, body: '' } : res;
}

function renderSkeleton(path: string): string {
  const stage = process.env['STAGE'] ?? 'local';
  return DOCTYPE + render(<Skeleton path={path} stage={stage} canonical={canonicalUrl(path)} />);
}
