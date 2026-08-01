# ADR-0002 — Payments, pricing and billing for v1

- **Status:** Accepted
- **Date:** 2026-07-28
- **Decision ticket:** [D2 — Lock the payments approach](https://github.com/topeomot2/all-links/issues/5)
- **Research:** [R2 — Payment processor & fee strategy for $2 micro-subscriptions](https://github.com/topeomot2/all-links/issues/3) (`docs/research/payments-fees.md`)

## Context

v1 sells a link-in-bio page at a price meant to undercut Linktree, with a 5-day trial and no permanent free tier. R2 established the governing fact: at a ~$2 charge the **fixed** part of a processor fee ($0.30–$0.50) dwarfs the percentage part, so monthly billing at $2 loses **18% (Stripe standard) to 30% (merchant of record)** of revenue before a cent of AWS cost. Annual billing amortizes that single fixed fee across twelve months and roughly quarters the drag.

The second axis is **merchant of record**. Stripe standard is the cheapest option but leaves the founder as seller of record — EU B2C digital-services VAT has **no registration threshold** for non-EU sellers, so an OSS registration and filing obligation begins at the first EU sale. The founder is a solo operator based in **Canada** selling to the US and Europe, and ruled decisively that they will not take on tax work.

Facts verified while deciding (2026-07-28):

- **Stripe Managed Payments** — Stripe's own MoR — entered **public preview February 2026** at 5% + $0.50, supports **Canadian sellers**, and handles tax compliance in 80+ countries. Subscriptions are supported via Stripe Billing but **only when created through Checkout or Payment Links**, which is the flow we want anyway. Trial support under SMP is not documented on the Managed Payments page.
- **Lemon Squeezy** — GA, Canadian sellers supported, tax remitted in 135+ countries, subscriptions and trials proven. Stripe-owned since July 2024; its founder confirmed in January 2026 that **migration paths to Stripe Managed Payments** are being built, making LS the sunsetting path.
- **Paddle** — requires custom pricing for products under $10, disqualifying for a $2.99 SKU on standard terms.

## Decision

### Pricing

| Plan | Price | Fee (5% + $0.50) | Net | Drag |
|---|---|---|---|---|
| **Annual** (default) | **$20/yr** (~$1.67/mo) | $1.50 | $18.50/yr | 7.5% |
| **Monthly** | **$2.99/mo** | $0.65 | $2.34/mo | 21.7% |

Both plans ship. **Annual is the default**, pre-selected at checkout, and carries the headline price (~$1.67/mo). Monthly is priced at $2.99 rather than $2.00 specifically so the fixed fee is absorbed rather than eating ~18–30% of a $2 sticker. This **supersedes the "~$2/mo" line** in the original v1 scope.

### Processor

**Stripe Managed Payments** (merchant of record). Tax is computed, collected and remitted by Stripe; the founder does no tax registration or filing. Same Stripe Checkout / webhook / API surface, one vendor alongside AWS, and no future migration since SMP is Stripe's end-state MoR product.

**Fallback: Lemon Squeezy**, to be taken without reopening this decision if, during build, SMP's preview cannot support a 5-day trial, cannot support the $2.99 / $20 SKUs, or blocks go-live for this account. Both are 5% + $0.50, so the fee math and the spec are unchanged either way — the integration is "redirect to hosted checkout, listen on a webhook, store subscription status" on both.

### Trial

**Card up front.** Signup routes directly to hosted checkout with a 5-day trial; the subscription is created immediately in `trialing`, the public page is **fully live during the trial**, and it auto-charges on day 5.

Consequence: **every account has a subscription object from the moment it exists**. There is no card-free account state, no day-5 conversion prompt, and no separate trial expiry job — the processor drives the whole lifecycle.

### Subscription state → public page visibility

| Subscription status | Public page at `linkix.io/<username>` |
|---|---|
| `trialing` | Live |
| `active` | Live |
| `past_due` | **Live** — dunning gets its full recovery window |
| `canceled` | **404 + branded "page not active" placeholder**, links hidden |
| `canceled` + 30 days | Username released back to the pool — **and the Account erased entirely (ADR-0012)** |

Page data and the username are **reserved for 30 days** after cancellation, so reactivation is one payment and the page returns unchanged. Status arrives by **webhook** and is stored on the account; *how* a status change invalidates a CloudFront-cached page is deliberately left to the serving-architecture ticket (A2), not fixed here.

**Amended by ADR-0012:** the 30-day mark is **terminal**, not merely a username release. It erases the whole item collection plus the Cognito user, driven by a one-shot EventBridge schedule the webhook creates on `canceled` and deletes on resubscribe. As written here the reservation expired but the data never did, leaving `email` in DynamoDB and Cognito indefinitely with no purpose — a storage-limitation exposure that needed no user to request anything. Erasure also **cancels the subscription before deleting**, since `mor_subscription_id` lives on the item being deleted.

## Consequences

**Positive**
- Zero tax compliance work, ever — the founder's hard requirement.
- Annual-default pricing keeps effective fee drag at ~7.5%, which the $2-tier price thesis survives.
- Card-up-front closes the spam-page abuse surface on a public UGC product and collapses account lifecycle to a single state machine.
- One vendor with AWS; no expected migration.

**Negative / accepted tradeoffs**
- **SMP is in public preview**, not GA — accepted, with Lemon Squeezy as the named escape hatch.
- **Monthly at $2.99 still carries 21.7% drag** — accepted as the price of offering a low-commitment entry point; annual is what the funnel pushes.
- **A card wall before any value is seen** will cut top-of-funnel signups versus a card-free trial — accepted in exchange for intent quality and abuse resistance.
- The MoR costs ~2.4 points more than Stripe standard ($0.48/user/yr annual, $3.12/user/yr monthly) — accepted as the price of never touching VAT/GST.

**Downstream constraints this imposes**
- **Data model (A1):** account must carry subscription status, `canceled_at`, and a username reservation whose release is 30 days after cancellation. **Widened by ADR-0012:** at that same 30-day mark the *entire* item collection is erased, not just the reservation released.
- **Auth (A3):** account creation and subscription creation are one flow — signup passes through hosted checkout.
- **Serving (A2):** must invalidate or gate a cached public page on webhook-driven status change.

## Alternatives considered

- **Stripe standard + Stripe Tax** — cheapest (5.1% annual / 12.9% monthly) and best tooling, but leaves the founder as seller of record with EU OSS registration and filing from the first sale. Rejected on the founder's explicit refusal to own tax.
- **Lemon Squeezy as primary** — GA and zero preview risk, but a known migration to SMP later plus a second vendor to operate. Kept as fallback rather than primary.
- **Paddle** — sub-$10 products need custom pricing; rejected as friction on a $2.99 SKU.
- **Annual-only at $20/yr** — best margin and simplest billing, rejected because a $20 upfront ask kills impulse signup for a cheap utility.
- **Monthly-only at $2.00** — matches the original scope line but bakes in 18–30% structural drag; rejected on R2's math.
- **Card-free trial** — wider funnel, rejected on spam-page abuse and the extra account state it forces.
- **Lapsed pages stay live read-only** — never breaks a printed link, rejected because it hands the product's core value away permanently after one payment.
