# R1 — Serverless platform cost & complexity comparison

**Ticket:** [#2](https://github.com/topeomot2/all-links/issues/2) · resolves facts for decision **D1** (#4)
**Question:** For a read-heavy, globally-cacheable "link in bio" workload at a ~$2/mo revenue ceiling, which serverless platform is cheapest + simplest — AWS serverless vs an edge alternative (Cloudflare)?
**Note:** This is a fact-gathering document. It deliberately does **not** pick a winner — that's D1.

Pricing pulled from official pages on 2026-07-28 (US pricing). All figures cited below.

## Assumptions used for the cost model

- A page view = **1 HTTPS request serving ~30 KB** (HTML + small CSS/JS; avatars cached separately, treated as negligible).
- **Scenario S (small):** 1,000 active pages × ~1,000 views/mo = **1M views/mo** → ~30 GB egress; ~1M analytics counter-writes/mo (naïve 1-write-per-view).
- **Scenario L (larger):** 10,000 active pages × ~1,000 views/mo = **10M views/mo** → ~300 GB egress; ~10M counter-writes/mo (naïve).
- Link edits are rare (a few per user/month) → negligible on every platform.

## Unit prices (cited)

| Component | AWS | Cloudflare |
|---|---|---|
| Compute requests | Lambda **$0.20 / 1M req**; 1M req + 400k GB-s free/mo [¹] | Workers free **100k req/day**; paid **$5/mo** incl 10M req, then **+$0.30/M** [⁴] |
| Compute duration | **$0.0000166667 / GB-s** (x86) [¹] | Paid incl 30M CPU-ms, then **+$0.02/M CPU-ms** [⁴] |
| API front door | API Gateway **HTTP API $1.00/M** req (REST $3.50/M) [²] | Included in Workers; no separate gateway |
| Static hosting / CDN | S3 + CloudFront; **CloudFront free tier: 1 TB egress + 10M HTTPS req/mo, always free** [³] | **Pages: unlimited requests, free bandwidth** |
| Egress beyond free tier | CloudFront regional **per-GB** (historically ~$0.085/GB US/EU — **confirm on live page** [³]) | **$0 — zero egress fees on Workers/Pages/R2/D1** [⁷] |
| Primary data store | DynamoDB on-demand: **$0.625/M writes, $0.125/M reads, $0.25/GB-mo**; 25 WCU/25 RCU/25 GB always-free [⁵] | D1: **rows-written 50M/mo free then $1.00/M; rows-read 25B/mo free then $0.001/M; 5 GB free then $0.75/GB-mo; zero egress** [⁶] |
| Key-value store | (use DynamoDB) | Workers KV: **reads $0.50/M (10M free), writes $5.00/M (1M free), $0.50/GB-mo** [⁴] |
| Object storage | S3 (charged egress via CloudFront) | R2: **$0.015/GB-mo, Class A $4.50/M, Class B $0.36/M, $0 egress**; 10 GB + 1M/10M ops free [⁷] |

## Modeled monthly cost (order-of-magnitude, at these scales)

| | AWS (static + CloudFront + DynamoDB counters) | Cloudflare (Pages static + D1 counters) |
|---|---|---|
| **Reads** — Scenario S (1M) | ~$0 (within 10M-req + 1TB free tier) | ~$0 (Pages free, egress free) |
| **Reads** — Scenario L (10M) | ~$0 (≈ at 10M-req free edge; 300 GB < 1 TB free) | ~$0 (Pages free) — or **$5/mo** if served via Workers (>3M/mo) |
| **Analytics writes** — S (1M) | 1M WRU × $0.625/M ≈ **$0.63** | within D1 50M/mo free → **$0** |
| **Analytics writes** — L (10M) | 10M WRU × $0.625/M ≈ **$6.25** | within D1 50M/mo free → **$0** |
| **Floor / fixed fee** | **$0** (pure pay-as-you-go) | **$0** on free plan; **$5/mo** once Workers Paid is needed |

At these scales **both platforms are effectively free** for the read path; the numbers are rounding error against revenue ($2k–$20k/mo). The differences that actually matter are qualitative, below.

## The three differences that matter at $2/mo

1. **Egress asymmetry (viral risk).** CloudFront's free tier (1 TB + 10M req/mo) covers small scale, but **AWS charges per-GB egress beyond it** (~$0.085/GB, confirm), while **Cloudflare never charges egress** [³][⁷]. One creator going viral (millions of views) can push a *single account* past 1 TB → an AWS egress bill against a $2 subscription. On Cloudflare that bill is $0. This is the sharpest cost-risk difference for a price-sensitive product.
2. **The analytics write-path is the real cost driver — and store choice dominates it.** Naïve per-view counter writes cost **$0.625/M on DynamoDB**, **$0 on Cloudflare D1** (50M/mo free), but a catastrophic **$5.00/M on Cloudflare KV** (only 1M free) [⁴][⁵][⁶]. Whatever platform wins, counting must use the right primitive (DynamoDB atomic counter / D1 / Cloudflare Analytics Engine — **never KV**), or batch/aggregate writes. This directly informs the "cheap click-counting" fog item.
3. **Operational complexity favors Cloudflare for this specific workload; AWS wins on maturity/flexibility.** Cloudflare = one platform (Workers + Pages + D1/KV/R2), **near-zero cold starts** (V8 isolates), **automatic free TLS + custom domains**, single Wrangler CLI, Miniflare local dev. AWS = more services to wire (Lambda + API GW + DynamoDB + S3 + CloudFront + ACM + Route 53), **Lambda cold starts** (100s of ms), but far deeper ecosystem, more mature IaC (CDK/SAM/SST), and skills that transfer. D1 is comparatively **newer** (maturity risk) vs DynamoDB's decade-plus track record.

## What the numbers imply (no decision made)

- On **raw cost at v1 scale, it's close to a tie** — both are ~$0 for reads; AWS has a tiny analytics-write cost, Cloudflare a possible $5/mo floor. Neither threatens a $2/mo margin at 1k–10k users.
- **Cloudflare's structural edge is egress ($0) + operational simplicity + no cold starts** — well-matched to tiny cacheable pages.
- **AWS's edge is maturity, flexibility, ecosystem, and no fixed floor fee** — and its free tiers genuinely cover small scale.
- The decision (D1) therefore likely hinges on **non-cost factors**: the solo dev's existing familiarity/risk tolerance, willingness to bet on D1's maturity, and how much the viral-egress tail-risk is weighted. Confirm the CloudFront per-GB egress rate on the live pricing page before finalizing.

## Sources

1. [AWS Lambda Pricing](https://aws.amazon.com/lambda/pricing/) — $0.20/1M requests; $0.0000166667/GB-s; 1M req + 400k GB-s free/mo.
2. [Amazon API Gateway Pricing](https://aws.amazon.com/api-gateway/pricing/) — HTTP API $1.00/M (first 300M); REST $3.50/M.
3. [Amazon CloudFront Pricing](https://aws.amazon.com/cloudfront/pricing/) — free tier 1 TB egress + 10M HTTP/S requests + 2M Functions invocations/mo, always free; per-GB regional egress beyond (confirm current US/EU rate on page).
4. [Cloudflare Workers Pricing](https://developers.cloudflare.com/workers/platform/pricing/) — free 100k req/day; paid $5/mo incl 10M req + 30M CPU-ms, +$0.30/M req, +$0.02/M CPU-ms; KV reads $0.50/M, writes/deletes/list $5.00/M, storage $0.50/GB-mo.
5. [Amazon DynamoDB On-Demand Pricing](https://aws.amazon.com/dynamodb/pricing/on-demand/) — $0.625/M writes, $0.125/M reads, $0.25/GB-mo; 25 WCU/25 RCU/25 GB always-free.
6. [Cloudflare D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/) — rows-read 25B/mo free then $0.001/M; rows-written 50M/mo free then $1.00/M; 5 GB free then $0.75/GB-mo; no egress/throughput charges.
7. [Cloudflare R2 Pricing](https://developers.cloudflare.com/r2/pricing/) — $0.015/GB-mo storage; Class A $4.50/M, Class B $0.36/M; **zero egress**; 10 GB + 1M Class A + 10M Class B free/mo.
