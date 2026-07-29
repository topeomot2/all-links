---
status: accepted
---

# ADR-0008 — Analytics counting mechanism

- **Date:** 2026-07-29
- **Decision ticket:** [A4 — Analytics counting mechanism](https://github.com/topeomot2/all-links/issues/9)
- **Builds on:** ADR-0001 (AWS serverless), ADR-0003 (single-table model, atomic counters), ADR-0004 (serving architecture, `/px` constraint), ADR-0006 (counter Lambda, Function URLs behind OAC)
- **Amends:** ADR-0004 (adds a sixth CloudFront behavior)
- **Vocabulary:** see `CONTEXT.md` (Page, Link, Username, Account)

## Context

v1 scope is **minimal analytics**: per-Link click totals and per-Page view totals. Two numbers, shown to the creator in their dashboard. Time-series, referrers and geography are explicitly out of scope.

Two prior decisions fix the shape of the problem:

- **ADR-0003** put `clickCount` on each Link item and `pageViewCount` on the Page item, both incremented by atomic `ADD`, and chose separate Link items specifically so a click is an isolated single-item write rather than a contended whole-object rewrite.
- **ADR-0004** established that the public HTML is **byte-identical for every viewer** and cached at `s-maxage=60`, so the origin sees roughly one request per Page per minute. Counting in the renderer would report cache misses as views — a 10,000-view Page reporting ~60. That ADR therefore reserved an uncached `/px` behavior for view counting and handed the mechanism here. It reserved nothing for clicks.

The ticket framed this as a cost decision — atomic counters vs. queue-based batching vs. log aggregation. Priced out, **cost is not the binding constraint**:

| | approx. cost per million |
|---|---|
| CloudFront request | $0.75 – $1.00 |
| DynamoDB on-demand write (`ADD`) | $0.625 |
| Lambda request | $0.20 |
| DynamoDB eventually-consistent read (<4 KB) | $0.06 |
| *SQS request (the batching alternative)* | *$0.40* |

An event costs on the order of **$1–2 all-in**, and the **CloudFront request fee dominates the database write** — so any scheme that saves DynamoDB writes but still terminates an HTTPS request at the edge is optimising the smaller number. Batching ten events into one write saves ~$0.56 of DynamoDB and spends ~$0.40 of it on the queue, plus a second Lambda invocation. At 10k Accounts averaging 1k views/month the entire analytics bill is ~$10–20/mo against ~$16.7k/mo of revenue.

The real constraints are therefore **accuracy** and **operational surface for a solo founder** — not per-event cost.

## Decision

### Clicks — a server-side redirect

Links in the rendered HTML point at the origin, not the destination:

```html
<a href="/r/jane/01HX4K...">My shop</a>
```

```
GET /r/<username>/<linkId>
  → Query GSI1 where GSI1PK = USERNAME#<username>
      → Page item (accountId, active) + Link items
  → UpdateItem  PK=ACCOUNT#<accountId>, SK=LINK#<linkId>  ADD clickCount 1
  → 302  Location: <link.url>   (Cache-Control: no-store)
```

The count is **authoritative**: it works with JavaScript disabled — preserving the property ADR-0004 committed to — cannot be suppressed by an ad blocker, and cannot be lost.

Resolution reuses **the renderer's own query**. `accountId` is the Cognito `sub` (ADR-0005) and must not appear in a public URL, so the path carries the *username*, and the same single GSI1 query that renders a Page yields the owning account, the destination URL, and the `active` flag together. No new index, no new item type, and lapsed-Page gating comes free rather than as a second read.

**302, never 301.** A cached permanent redirect would count a visitor once and never again, and would keep sending traffic to a destination the creator has since edited. The response is `no-store` for the same reason.

### Views — a 1×1 pixel

```html
<img src="/px?u=jane" width="1" height="1" alt="" aria-hidden="true">
```

```
GET /px?u=<username>
  → Query GSI1 where GSI1PK = USERNAME#<username>, GSI1SK = 0, Limit 1
  → UpdateItem  PK=ACCOUNT#<accountId>, SK=PAGE  ADD pageViewCount 1
  → 204
```

A pixel over a `sendBeacon`: it needs no client runtime on a document ADR-0004 deliberately kept runtime-free, and it **filters bots for free** — crawlers and link unfurlers fetch the HTML but not inline images, so the largest source of false views excludes itself with no code.

### Write path — direct, synchronous, best-effort

The counter Lambda issues the atomic `ADD` inline and responds. No queue, no batch job, no aggregation: counts are **live**, the dashboard reads the item, and there is exactly one source of truth.

The write is **best-effort**. If DynamoDB errors or throttles, the Lambda logs it and **still redirects / still returns 204**. Analytics must never be able to break a click.

### Bot and abuse filtering — free heuristics only

Beyond the pixel's structural filtering, two zero-cost checks before the `ADD`:

- **User-Agent denylist** for self-identifying crawlers.
- **Same-origin `Referer`** required on `/px`.

No WAF, no per-IP dedupe store, **no visitor IPs recorded at all** — which keeps a public analytics endpoint clear of personal data for the European market ADR-0002 targets.

These counts are **approximate and never a billing input**. A creator inflating their own page views is lying only to themselves; the cost exposure of a scripted attack is bounded by the AWS Budgets alarm ADR-0001 already requires.

### Misses

Any lookup failure on `/r/*` — link deleted, Page inactive, username renamed or absent — resolves to a single rule: **302 to `/<username>`**.

The common miss is benign and self-correcting. ADR-0004's 60-second TTL means a visitor can click a link the creator edited or deleted seconds ago; bouncing them to the Page shows the current links instead of a dead end. Where the Page is genuinely inactive or the username is gone, they land on ADR-0004's **existing** lapsed/unclaimed placeholders — so this reuses that copy rather than introducing a third.

### Namespace — amends ADR-0004

A sixth behavior joins the single distribution:

| Behavior | Origin | Caching |
|---|---|---|
| `/r/*` **(new)** | counter Lambda | `no-store` |

`/px` and `/r/*` are served by **one Lambda**. They share the username → account lookup, and — more usefully — their combined traffic keeps a single function warm, which is what blunts the cold-start penalty this decision otherwise puts on the product's hottest interaction.

`/px` must forward the `u` query string to the origin. Neither route needs a denylist entry: ADR-0007's three-character username minimum already excludes `r`, as it does `a` and `px`.

## Considered options

**Click capture**

- **Direct `href` + `navigator.sendBeacon`.** Zero added latency, the real URL visible on hover, and the link keeps working even if our Lambda is down. Rejected: it silently under-reports for no-JS and ad-blocked visitors, and ADR-0004 rejected an earlier design on precisely the grounds that an analytics feature that lies is worse than none.
- **Redirect `href` with a JS fast path** that intercepts and goes direct. Fast for most visitors and correct for the rest, at the cost of two counting paths to keep consistent, a double-count risk, and a runtime on a document kept deliberately runtime-free.

**Link resolution**

- **Signed opaque token** `/r/<token>` encoding account, link and destination — zero reads on the click path, the cheapest and fastest possible redirect. Rejected: it must be *encrypted* rather than merely signed to avoid leaking `accountId`, key rotation breaks tokens already baked into cached HTML, and with no read there is no `active` flag — a lapsed Page's links would keep redirecting.
- **A standalone `LINKREF#<ulid>` lookup item** giving an O(1) `GetItem` and the shortest URLs. Rejected: a fifth item type, a second write on every link mutation, a duplicated `url` free to drift, and still no `active` flag.

**Write path**

- **SQS buffer + aggregating consumer.** Absorbs viral spikes and protects the per-item write ceiling, but adds a queue, a consumer and a DLQ to operate, delays counts, and at this volume is not cheaper — the queue costs roughly what the write it replaced cost.
- **Kinesis Firehose → S3 → scheduled aggregation.** Genuinely cheapest per event at large scale ($0.029/GB) and yields a raw event archive. Rejected: an entire data pipeline, plus hour-scale staleness, for two numbers per Page.
- **CloudFront access-log aggregation.** Captures cache hits with no hook in the HTML. Rejected here for the same reason ADR-0004 rejected it: log storage, a batch job, and counts lagging by minutes to an hour.

**Filtering**

- **AWS WAF rate-based rules** on `/px` and `/r/*`, stopping inflation and cost bleed at the edge before either reaches a Lambda. Rejected: ~$6/mo fixed plus $0.60/M requests — at launch the single largest line on the bill, and exactly the kind of permanent floor ADR-0001 and ADR-0005 both optimised away.
- **Per-IP dedupe window in DynamoDB** for unique-visitor semantics. Rejected: doubles the write cost of every event and stores visitor IPs, taking on a privacy obligation to deliver a metric this scope calls minimal.

**Misses**

- **A dedicated "link no longer available" 404.** More honest, but a third placeholder to maintain and a dead end in the common benign case.
- **Distinguishing deleted-link from inactive-Page.** Three code paths on the hottest interaction for a distinction no visitor would notice.

## Consequences

**Accepted tradeoffs**

- **The destination URL is hidden** behind `ourapp.com/r/…` on hover and in the status bar. Standard for link-in-bio products, but it is a genuine transparency cost.
- **Every outbound link now depends on the counter Lambda.** If it is down, links do not merely go uncounted — they do not work. This is the price of an authoritative count, and it is why the write is best-effort: a *database* failure must still redirect.
- **Latency on the click path** — one GSI1 query plus one write, ~100 ms warm, 200–500 ms on a cold start. Shared warmth with `/px` mitigates it; it is not eliminated.
- **Three requests per page view**, where ADR-0004 budgeted two.
- **Counts are approximate.** Headless browsers and determined scripts are not filtered.
- **Counts are lifetime monotonic totals** — no time dimension, no reset. They survive reordering (ADR-0003's stable ULID sort key) and are lost when a Link is deleted and recreated.
- **Per-partition write ceiling** of ~1000 writes/s, shared across an Account's whole item collection. Only a viral Page could approach it. Should it ever matter, a buffer retrofits **behind the same `/px` and `/r/*` URLs with no change to the public HTML** — the contract is the URL, not the mechanism.
- **A rename orphans in-flight cached `/r/<oldname>/…` links**, which 302 to `/<oldname>` and land on the unclaimed placeholder. Consistent with ADR-0003 and ADR-0007 accepting that old URLs 404.

**Downstream constraints this imposes**

- **The renderer emits `/r/<username>/<linkId>` hrefs, not raw destination URLs**, plus the pixel — so the public HTML is coupled to this decision.
- **The redirect re-validates that the stored URL is `http(s)`** before issuing the `Location` header. ADR-0006 validates at write time; `/r/*` is otherwise an open-redirect surface, and a redirector is worth defending twice.
- **CDK** must express the sixth behavior, `no-store` on `/r/*`, and query-string forwarding on `/px`.
- **The dashboard** reads `clickCount` and `pageViewCount` from the items it already fetches in its `Query PK=ACCOUNT#<id>` — no analytics read path to build.
- **Rate-limiting `/px` and `/r/*`** is deliberately left to the abuse/takedown story, alongside the OTP-send and claim endpoints ADR-0007 deferred there.
