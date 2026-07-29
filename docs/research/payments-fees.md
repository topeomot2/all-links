# R2 — Payment processor & fee strategy for $2 micro-subscriptions

**Ticket:** [#3](https://github.com/topeomot2/all-links/issues/3) · resolves facts for decision **D2** (#5)
**Question:** At ~$2/mo, what processor + billing strategy minimizes fee drag while supporting a 5-day trial and subscription billing?
**Note:** Fact-gathering only — does **not** pick a processor (that's D2).

Pricing pulled from official pages on 2026-07-28 (US). All figures cited below.

## The core problem: the fixed per-transaction fee destroys micro-charges

At $2/month, the **fixed** part of every fee ($0.30–$0.50) dwarfs the percentage part. This is the single most important fact in this document.

| Processor | Headline fee | Fee on a **$2/mo** charge | Effective % (monthly) | Merchant of Record? |
|---|---|---|---|---|
| **Stripe** | 2.9% + $0.30 [¹] | $0.058 + $0.30 = **$0.358** | **~17.9%** (+0.7% Billing = ~18.6%) | **No** — you own sales tax/VAT |
| **Paddle** | 5% + $0.50 [²] | $0.10 + $0.50 = **$0.60** | **~30%** | **Yes** — tax handled |
| **Lemon Squeezy** | 5% + $0.50 [³] | $0.10 + $0.50 = **$0.60** | **~30%** | **Yes** — tax handled |

⚠️ **Monthly billing at $2 loses 18–30% of every dollar to fees before a cent of AWS/Cloudflare cost.** Paddle additionally notes products **under $10 require contacting them for custom pricing** [²] — a potential disqualifier for a standard $2/mo plan; verify in D2.

## The decisive lever: annual billing amortizes the fixed fee

Charging once a year spreads the single fixed fee across 12 months. Same processors, at a **$20/year** price (≈ $1.67/mo, a discount vs $2):

| Processor | Fee on **$20/yr** charge | Effective % (annual) | vs monthly |
|---|---|---|---|
| **Stripe** | 2.9%×$20 + $0.30 = **$0.88/yr** (+0.7% = ~$1.02) | **~4.4%** (~5.1% w/ Billing) | 17.9% → **4.4%** |
| **Paddle** | 5%×$20 + $0.50 = **$1.50/yr** | **~7.5%** | 30% → **7.5%** |
| **Lemon Squeezy** | 5%×$20 + $0.50 = **$1.50/yr** | **~7.5%** | 30% → **7.5%** |

**Annual billing roughly quarters the effective fee.** For a price-competitive product this is close to mandatory — the pricing/packaging decision (D2) and this fee math are inseparable. Monthly can still be offered, but its true cost (~18–30%) must be priced in or nudged toward annual.

## Merchant of Record — the second axis

- **Stripe = not MoR.** Lowest fees, but **you are the seller of record**: you owe sales-tax/VAT registration, collection, filing, and remittance across jurisdictions. Stripe Tax exists as an add-on (~0.5%) but **you still file**. Real ongoing burden for a solo founder selling to a global creator audience.
- **Paddle / Lemon Squeezy = MoR.** They are the seller of record and **calculate, collect, and remit VAT/GST/sales tax in 135+ countries** for you [³]. The extra ~2% (and the higher fixed fee) buys away nearly all tax/compliance work and global-selling risk.
- **Context:** Stripe **acquired Lemon Squeezy in July 2024**; as of 2026 Lemon Squeezy still operates independently, and Stripe is rolling out its own MoR product, **Stripe Managed Payments, at 5% + $0.50** [³] — i.e. Stripe's own MoR option matches Paddle/LS pricing, not Stripe-standard.

So the real trade is: **Stripe-standard (cheapest fees, you own global tax) vs an MoR (Paddle / Lemon Squeezy / Stripe Managed Payments — ~2%+ more, tax + compliance handled).** At $2/mo the ~2% is meaningful, but so is the cost/risk of mishandling international tax as a solo operator.

## Trial mechanics (5-day trial)

- **Card-required-up-front:** fewer, higher-intent trials; **far less abuse** — important here because the product is a **public UGC surface** (a card-free 5-day trial invites spam-page/throwaway-account abuse). Auto-converts to paid at day 5.
- **Card-not-required:** higher trial volume, more top-of-funnel, but abuse-prone and needs a conversion prompt at day 5.
- **Support:** Stripe supports both natively (`trial_period_days`, with or without a payment method + `trial_settings`). Paddle and Lemon Squeezy, as MoR, also support trials, typically card-first.
- **Given the abuse surface + 5-day length, card-up-front is the safer default** — but this is a D2 call.

## Subscription state & dunning (needed to gate page visibility)

- All three expose the subscription lifecycle (**trialing / active / past_due / canceled**) via **webhooks + API**, which is what gates whether a lapsed creator's public page stays visible (a fog item downstream of D2).
- **Dunning:** Stripe Billing has Smart Retries + configurable dunning emails; Paddle/LS handle failed-payment recovery automatically as MoR.
- **Min integration surface:** all three offer **hosted checkout + webhooks** (Stripe Checkout + Customer Portal; Paddle/LS overlay checkout), so the build is "redirect to hosted checkout, listen on a webhook, store subscription status" on any of them.

## What the numbers imply (no decision made)

- **Annual billing is effectively required** for the price thesis to survive — it's the difference between ~5% and ~18–30% fee drag. D2 should decide monthly-vs-annual-vs-both alongside the processor.
- The processor choice reduces to **fees vs tax-burden**: Stripe-standard (cheapest, you own global tax compliance) vs MoR (Paddle/LS/Stripe Managed Payments — pay ~2%+ more, offload tax entirely).
- **Verify before deciding:** whether Paddle will support a sub-$10 plan on standard terms; current Stripe Billing fee (~0.5–0.7%) and Stripe Tax add-on %; exact Lemon Squeezy terms post-acquisition.

## Sources

1. [Stripe Pricing](https://stripe.com/pricing) — 2.9% + $0.30 per successful card charge; Billing pay-as-you-go 0.7% of billing volume. (Fetch geo-resolved to CA — CA$0.30; US standard is US$0.30, same structure.)
2. [Paddle Pricing](https://www.paddle.com/pricing) — 5% + 50¢ per checkout transaction; merchant of record incl. global/cross-border sales-tax compliance; products under $10 require custom pricing.
3. Lemon Squeezy — 5% + $0.50 as merchant of record (VAT/GST/sales tax remitted in 135+ countries); acquired by Stripe July 2024; Stripe Managed Payments launching at 5% + $0.50. Sources: [Lemon Squeezy MoR fees (2026)](https://getstacksmart.com/blog/lemon-squeezy-merchant-of-record-fees-2026), [Stripe acquires Lemon Squeezy](https://www.lemonsqueezy.com/blog/stripe-acquires-lemon-squeezy), [Stripe + Lemon Squeezy update 2025](https://www.lemonsqueezy.com/blog/stripe-lemon-squeezy-update-2025). *(lemonsqueezy.com/pricing returned HTTP 403 to automated fetch; figures corroborated across the above.)*
