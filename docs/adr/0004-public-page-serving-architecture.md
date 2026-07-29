---
status: accepted
---

# ADR-0004 — Public-page serving architecture

- **Date:** 2026-07-29
- **Decision ticket:** [A2 — Public-page serving architecture](https://github.com/topeomot2/all-links/issues/7)
- **Builds on:** ADR-0001 (AWS serverless), ADR-0002 (payments — lapse gating), ADR-0003 (single-table data model)
- **Vocabulary:** see `CONTEXT.md` (Page, Link, Username, Theme, Subscription)

## Context

`ourapp.com/<username>` is the product's hot path: a public, cacheable, mostly-static document served to the whole internet, at a revenue ceiling of ~$1.67/mo per Account. ADR-0003 made a public render **one GSI1 query** returning the Page plus its Links in rank order, and put a mirrored **`active`** flag on the Page so visibility can be gated without reading the private Account item. ADR-0002 requires a lapsed Page to return **404 with a branded placeholder**, and deliberately left the *mechanism* to this decision.

Two cost facts drove the design:

- **CloudFront invalidations** are free for the first 1,000 paths/month, then **$0.005 per path**. Invalidating on every edit costs roughly **$250/mo at 10k Accounts editing 5×/month** — fatal at this price point.
- **A Lambda render costs ~$0.0000003** (~$0.30 per million), and the DynamoDB read behind it is similarly negligible.

Serving a cache miss is therefore nearly free, while *invalidating* is not. The cache exists to absorb viral spikes, not to save money on ordinary reads — which inverts the usual "pre-generate everything" instinct.

## Decision

### Serving model

**CloudFront in front of a Lambda Function URL** that renders HTML on demand from DynamoDB. No pre-generated static artifacts.

```
GET /jane
  CloudFront HIT   → HTML from the edge
  CloudFront MISS  → Lambda → 1 GSI1 query → render HTML → cached
```

DynamoDB remains the **single source of truth**. There is no publish pipeline, no S3 page objects to reconcile, no rebuild needed when a template changes, and a Username rename migrates nothing. `active=false` is enforced in render logic, so no stale artifact can serve a lapsed Page.

### Freshness

```
Cache-Control: public, s-maxage=60, max-age=0
```

**No routine invalidation.** A write path (edit, reorder, theme change, rename, billing webhook) writes DynamoDB and stops — it never calls CloudFront. The public Page catches up within 60 seconds.

Consequences: zero invalidation cost at any scale; no invalidation call to retry, queue, or fail; and the system is **self-healing** — a missed `active`-flag write corrects itself within a minute rather than leaving a lapsed Page live indefinitely. Invalidation remains available for **rare exceptional events only** (abuse takedown, DMCA), whose volume sits well inside the free 1,000 paths/month.

### Negative path

Both "no such Username" and "Page not `active`" return **404**, cached at the same `s-maxage=60`, with **different bodies**:

| Case | Body |
|---|---|
| Username unclaimed | "`/jane` is available — claim it", with a signup CTA |
| Page inactive (lapsed) | Neutral "this page isn't active" — **never** names billing |
| Username reserved | Neutral body, no CTA |

The unclaimed body turns stray traffic into an acquisition funnel; the lapsed body avoids publicly outing a creator as unpaid. Matching the live TTL means a freshly claimed Username goes live within 60 seconds of signup.

### Rendered artifact

One **self-contained HTML document**: the Theme's CSS is inlined (presets are few and small), no external stylesheet, no framework runtime, and the Page renders with JavaScript disabled. ~~The avatar is served from the **same** CloudFront distribution off S3 via `avatarKey`.~~ **Amended by ADR-0009:** the avatar is a ≤24 KB WebP blob stored on the Page item and inlined as a `data:` URI, so it ships inside the document; an avatar-less Page renders a themed CSS monogram.

~~**Two requests per page view** (document + avatar).~~ **Amended by ADR-0009: one request per page view** — the document alone, avatar included. Nothing to hash, version, or cache-bust; a theme change is a pure server-side concern.

### Counting

The cached HTML is **byte-identical for every viewer**, so nothing per-view can be counted in the renderer — at `s-maxage=60` the origin sees roughly one request per Page per minute, not one per view. Page views are therefore counted **off the read path**, via a hook the render embeds pointing at a separate, never-cached endpoint.

This ADR fixes only the constraint. The mechanism — tracking pixel vs inline beacon, write batching, bot filtering — belongs to **A4 (analytics counting)**.

### Namespace

**One CloudFront distribution**, routing by path prefix, with the page renderer as the catch-all:

| Behavior | Origin | Caching |
|---|---|---|
| `/api/*` | app Lambda | `no-store` |
| `/app/*` | dashboard | `no-store` — **amended by ADR-0006**: shell `no-store`, hashed assets immutable |
| ~~`/a/*`~~ | ~~S3 (avatars)~~ | **removed by ADR-0009** — avatars inline in the document |
| `/px` (counting endpoint) | counter Lambda | `no-store` — **ADR-0008**: 1×1 pixel, `u` query string forwarded |
| `/r/*` (click redirect) | counter Lambda | `no-store` — **added by ADR-0008** |
| `/*` **(default)** | **page renderer Lambda** | `s-maxage=60` |

The default behavior's cache policy forwards **no cookies**, so dashboard session cookies never fragment the public cache. One distribution, one certificate, one deploy.

## Considered options

- **Pre-generated static HTML to S3.** Cheapest reads and no cold starts, but introduces a second source of truth that can drift, forces every subscription-state change to rewrite or delete an object, makes a rename an object move, and needs a rebuild script for template changes. Rejected: the read cost it saves is already ~$0.
- **Lambda@Edge / CloudFront Functions.** Lowest miss latency globally, but cross-region DynamoDB reads (or Global Tables), slow replicated deploys, and awkward debugging — a large complexity tax for a solo founder.
- **Static-first with stale-while-revalidate.** Requires building and operating *both* the static pipeline and the renderer, and can serve a lapsed or abusive Page stale — precisely the case where staleness is least acceptable.
- **SPA shell + client fetch.** A link-in-bio Page is a crawled, unfurled, zero-interactivity document; client rendering hurts SEO, OG previews, and first paint for no benefit.
- **Long TTL + invalidate on every write.** Instantly fresh, but ~$250/mo at 10k Accounts and makes a CloudFront call a dependency of every mutation — a failed invalidation leaves a stale or, worse, a lapsed-but-live Page.
- **Counting on cache miss in the renderer.** Free and simple, but reports cache misses as views (a 10,000-view Page might report ~60). An analytics feature that lies is worse than none.
- **Deriving counts from CloudFront access logs.** Captures cache hits with no client hook, but adds log storage, a batch job, and counts that lag by minutes to an hour.
- **App on `app.ourapp.com`.** Cleaner cookie isolation and a purer root namespace, but a second distribution and origin to operate plus a cross-origin auth handoff — and marketing routes still need reserving at the root.
- **Confining app routes under a `/_/` prefix.** Reduces the denylist to one token forever, at the cost of URLs like `/_/pricing` on the pages that most need to look legitimate.

## Consequences

**Accepted tradeoffs**
- **Cold start on a cache miss** (~200–500 ms). Accepted; low-traffic Pages miss often, but the absolute latency is acceptable for a static-feeling document.
- **Edit → public visibility takes up to 60 s.** The dashboard previews directly from DynamoDB, so the editing experience is instant; only the public URL lags.
- **The reserved-name denylist must track every app route forever** — currently `api`, `app`, `a`, `px`, `r` (ADR-0008), plus marketing routes.
- Theme CSS is re-sent with every document rather than shared-cached (kilobytes, gzipped).

**Constraints this imposes downstream**
- **A4 (analytics counting):** page views must be counted on the uncached `/px` behavior, not in the renderer. A4 chooses pixel vs beacon, batching, and bot filtering. **Resolved by ADR-0008** — a 1×1 pixel on `/px`, clicks via a new `/r/*` server-side redirect behavior (a sixth behavior, added to the table above), direct best-effort atomic `ADD` with no batching, and bot filtering limited to free heuristics.
- **A5 (framework + IaC):** the framework must server-render self-contained HTML for public Pages (no SPA); IaC must express one distribution with the five behaviors above and their distinct cache policies, including the no-cookie policy on the default behavior. **Resolved by ADR-0006** — no meta-framework, Preact `render-to-string` in the renderer Lambda, AWS CDK for the distribution. ADR-0006 amends the `/app/*` row: the dashboard is a static SPA, so its hashed assets are immutable and only the HTML shell is `no-store`.
- **Onboarding flow:** the reserved denylist is now partly determined by this routing table.
- **Avatar delivery** via `/a/*` exposes an egress and abuse vector — upload size/format limits and resize-on-upload are still to be decided. **Resolved by ADR-0009** — by deleting the vector rather than bounding it: `/a/*` and the avatar bucket are removed, the avatar becomes a ≤24 KB WebP blob on the Page item inlined as a `data:` URI, and a page view drops from two requests to one.
