# ADR-0001 — AWS serverless platform for v1

- **Status:** Accepted
- **Date:** 2026-07-28
- **Decision ticket:** [D1 — Lock the serverless platform](https://github.com/topeomot2/all-links/issues/4)
- **Research:** [R1 — Serverless platform cost & complexity comparison](https://github.com/topeomot2/all-links/issues/2) (`docs/research/platform-comparison.md`)

## Context

v1 is a cheap, serverless "link in bio" product with a ~$2/mo revenue ceiling, so per-user infra cost and operational simplicity are hard constraints. R1 compared AWS serverless vs Cloudflare (Workers/Pages/D1/R2) and found **cost is roughly a tie at v1 scale** — both are ~$0 for the read path and neither threatens a $2 margin at 1k–10k users. The decision therefore turned on tiebreakers: operational simplicity, the viral-egress tail risk, data-store maturity, and — decisively — **the solo founder's existing platform fluency**.

The founder has **strong AWS experience** (Lambda/DynamoDB/CloudFront), which neutralizes AWS's main weakness (wiring complexity) and makes AWS the fastest path to ship.

## Decision

Build v1 on **AWS serverless**:

- **Compute:** AWS Lambda (Node/TypeScript).
- **Data store:** Amazon DynamoDB, **on-demand** billing — scales to zero with **no fixed floor fee** (critical at $2/mo), generous always-free tier, cheap atomic counters for the analytics write-path. This commits us to **NoSQL / single-table modeling**.
- **Static/page hosting:** Amazon S3 + CloudFront (public pages served cached from the edge; S3 origin).

The API front door (Lambda Function URLs vs API Gateway HTTP API) and the page **serving architecture** (pre-generated static vs render-on-cache-miss) are deliberately *not* fixed here — they are downstream tickets that build against this stack.

## Consequences

**Positive**
- Fastest path for this founder; mature ecosystem; transferable skills.
- **No fixed monthly floor** — on-demand/scale-to-zero across Lambda, DynamoDB, S3, CloudFront.
- CloudFront free tier (1 TB egress + 10M requests/mo, account-wide) covers substantial early traffic.

**Negative / accepted tradeoffs**
- **Egress is billed beyond CloudFront's 1 TB/mo free tier** (~$0.085/GB) — the one thing Cloudflare would have made free. Accepted: pages are tiny (~30 KB) and highly cacheable, so 1 TB ≈ 35M views/mo; the painful tail (few paying users + one viral creator) is rare and cappable. **Mitigation:** aggressive CloudFront caching + an AWS Budgets billing alarm (to be added in the infra ticket).
- **Lambda cold starts** (100s of ms) accepted.
- **NoSQL single-table modeling** required (shapes the data-model ticket).

## Alternatives considered

- **Cloudflare (Workers + Pages + D1 + R2):** structurally strong for this workload — **zero egress**, near-zero cold starts, one-platform simplicity, D1 free to 50M writes/mo. Rejected on **founder familiarity / velocity**, given cost was a tie. Reconsider only if the destination is redrawn. Note: the analytics write-path must avoid Cloudflare KV ($5/M writes) — moot here, but recorded from R1.
- **Aurora Serverless v2:** relational, but carries a **minimum-capacity floor cost** (tens of $/mo even idle) — disqualified at a $2/mo price point.
