---
status: accepted
---

# ADR-0009 — Abuse, takedown & rate limiting

- **Date:** 2026-07-29
- **Decision ticket:** [A8 — Abuse, takedown & rate limiting](https://github.com/topeomot2/all-links/issues/16)
- **Builds on:** ADR-0001 (AWS serverless, Budgets alarm), ADR-0002 (card up front, lapse policy), ADR-0003 (single-table model, mirrored `active` flag), ADR-0004 (CloudFront serving, invalidation policy), ADR-0005 (Cognito passwordless OTP over SES), ADR-0006 (Lambdas behind Function URLs + OAC, CDK), ADR-0007 (username claim, lazy harvest, denylist), ADR-0008 (`/px` and `/r/*`, no WAF)
- **Amends:** ADR-0003 (Page gains `suspendedAt`), ADR-0004 (names the trigger for its reserved invalidation path), ADR-0007 (held-handle attribute on the Account, delete-on-reclaim, harvest skips suspended Pages, denylist gains `terms`/`privacy`)
- **Vocabulary:** see `CONTEXT.md` (Account, Page, Link, Username, Subscription, Suspension)

## Context

This is the last cross-cutting decision, and three ADRs deferred parts of it here:

- **ADR-0004** reserved CloudFront invalidation for "rare exceptional events only (abuse takedown, DMCA)" but never said what triggers one or how a Page is pulled.
- **ADR-0007** declined a profanity list on the explicit grounds that "takedown is the lever", and left OTP-send and username-claim rate limiting to this ticket.
- **ADR-0008** rejected AWS WAF at ~$6/mo as the largest line on a launch bill, accepted approximate counts, and left rate limiting on `/px` and `/r/*` here.

Two prior decisions constrain the answer more than anything about abuse itself:

- **`active` is a pure function of Subscription status.** ADR-0002 and ADR-0007 worked to collapse account lifecycle onto that single mirrored flag. A moderation state that writes `active` un-collapses it — the billing webhook would silently un-suspend a Page on the next `active=true` event.
- **Every mechanism must have a $0 floor.** ADR-0001 and ADR-0005 both chose no-floor services over better products with a fixed monthly fee; ADR-0008 rejected WAF on exactly that basis. A rate-limiting scheme with a standing monthly cost contradicts three prior decisions.

Working in our favour and already paid for: **card up front** (ADR-0002). Every Page costs $20/yr and a real payment card. That is the single most effective spam filter available to a UGC product, and it is free. Most of what follows is calibrated to a world where mass automated abuse has to buy its way in.

## Decision

### 1. Takedown

**A Suspension is a separate state from a lapse.** The Page item gains **`suspendedAt`** (an ISO timestamp; absent means not suspended). The renderer's visibility test becomes `active && !suspendedAt` — both attributes already arrive in the single GSI1 query of ADR-0003, so this costs no extra read and no extra write on the billing path. The billing webhook never touches `suspendedAt`; a lapse, a re-subscribe, or a payment recovery cannot revive a suspended Page.

A suspension is followed by a **CloudFront invalidation of that one path** — this is the "rare exceptional event" ADR-0004 reserved invalidation for, and now the only thing that triggers one. Without it a suspended Page stays served for up to 60 s; with it the takedown is immediate. Volume sits far inside the free 1,000 paths/month.

**Reports arrive by email.** Every public Page carries a small footer line linking `mailto:abuse@ourapp.com?subject=Report: <username>`. This is the only intake channel: it adds no endpoint, no form, no unauthenticated write path, and no runtime to a document ADR-0004 deliberately kept runtime-free. The subject line carries the username, so triage is a mail filter. The founder judges reports personally; there is no SLA, no queue tooling, and no appeals process beyond replying to the mail.

**Suspending an Account does three things**, in this order:

1. Set `suspendedAt` on the Page and invalidate its path.
2. **Cancel the Subscription** with the merchant of record. Continuing to charge an account whose page has been pulled invites a dispute and is indefensible on its own terms.
3. **Tombstone the Username.** ADR-0002 releases a canceled Account's handle after 30 days and ADR-0007 harvests it lazily on contention — which would hand the handle back to the same actor with a fresh email. The harvest condition therefore gains one clause: **never harvest a Username whose Page is suspended.** The harvest already reads that item, so this is a condition, not a mechanism. Handles stay burnt until manually released — which is the remedy for the impersonation case, where the rightful owner wants the name.

**Phishing and shared domain reputation.** Path-based addressing (ADR-0004) means one domain's reputation is shared by every creator, and a blocklisting takes out signup and billing alongside the pages. Two things bound this. Structurally, `/r/<username>/<linkId>` is **not** an arbitrary open redirector: the destination must be a Link a paying creator saved, resolved from DynamoDB, so it cannot be used to launder a URL through our domain without an account. On top of that, link create/update in the dashboard performs a **synchronous Google Safe Browsing Lookup** and refuses the save on a positive hit. The check **fails open** on error or timeout, runs only on the authenticated dashboard path, and never touches the public read path. It is free at our volumes and needs no review queue — it either blocks the save or it does not.

### 2. Rate limiting

**Per-endpoint answers on a shared free floor — not one mechanism.** The endpoints protect different things: OTP-send protects sender reputation and a third party's inbox; the claim endpoint protects identity; `/px` and `/r/*` protect nothing but the bill, because ADR-0008 already established that counts are approximate and never a billing input. A single shared limiter would put a DynamoDB write in front of every request on the two highest-volume endpoints — roughly doubling the cost of an event — to defend numbers we have already agreed are approximate.

**The floor**, applied to every function:

- **Reserved concurrency on every Lambda**, sized to plausible peak. This is free and it is the real cost ceiling: an attack cannot outrun a concurrency cap into an unbounded bill.
- **AWS Budgets alarm** (already required by ADR-0001) as the backstop.

The floor is a **cost ceiling, not a fairness mechanism** — under attack, legitimate traffic is throttled alongside the attack, and a genuinely viral Page will shed requests. Accepted deliberately: at a $20/yr price, a 503 on a spike is recoverable and an unbounded bill is not.

**On top of the floor, one endpoint gets a per-actor limit: OTP-send.**

What is being protected is **SES sender reputation**, not cost — email is $0.10/1000, so bombing an inbox is cents, but complaints from the victim degrade deliverability, and on a passwordless product deliverability *is* login. The limit is an atomic `ADD` against a TTL'd counter item in the existing table, keyed by a hash of the email address: **5 sends/hour, 20/day**, refusing beyond that.

It lives in a **Cognito Lambda trigger**, because the SPA authenticates against Cognito directly (ADR-0005/0006) and none of our Lambdas sit in that path. This keeps the throttle inside the auth flow ADR-0005 bought off the shelf and adds no endpoint. **Build-time check:** confirm which trigger fires on each send under Cognito's *managed* `EMAIL_OTP`; if none does, fall back to proxying `InitiateAuth` through the api Lambda. Cognito's own account-level throttling remains as a global cap but does nothing per-victim, which is the case that costs reputation.

**Username enumeration is not a threat and gets no limit.** The public site already answers "is this handle taken?" for free — 200 versus 404, served from the edge — so an availability endpoint reveals strictly less than CloudFront does. By ADR-0007's ordering (OTP → claim) the check already sits behind a verified account regardless. This is recorded here so it stops being re-deferred.

**Bulk claiming is real and is closed structurally, not by a limit.** Under ADR-0007 a claim writes only the Username item and mints a 7-day hold, so a loop can hold thousands of handles, orphaning the previous item each time; the lazy harvest only reclaims names someone actively contends for. The fix is **delete-on-reclaim**: the Account records its currently-held handle, and claiming a new one **deletes the previous Username item in the same transaction**. "One held handle per Account" becomes structural, matching one-Page-per-Account, and no counter is needed.

**`/px` and `/r/*` get no per-actor limit.** Floor only. No per-IP counters and no visitor IPs of any kind — hashed or not, a per-visitor identifier is exactly what ADR-0008 refused in order to keep the public endpoints clear of personal data for the European market.

**Escalation is decided now, not during the incident.** Trigger: the Budgets alarm, or a CloudWatch alarm on counter/`px` invocations past a daily threshold (free within the first ten alarms). Response: **deploy AWS WAF rate-based rules** on `/px`, `/r/*`, and the api Function URL, accepting the ~$6/mo ADR-0008 rejected *at launch*. WAF was never rejected on merit — only on floor cost at zero revenue — so this is a pricing decision that flips the moment there is traffic to defend. If a domain blocklisting ever lands, the further escalation is splitting public pages onto a separate domain from dashboard and billing; not done at v1 because it reopens ADR-0004's single-distribution model for a risk that card-up-front makes unlikely.

### 3. Policy surface

The suspend lever enforces a policy, so the policy has to exist. v1 ships **`/terms`** (terms of service including an acceptable-use policy naming what gets a Page suspended) and **`/privacy`** (which is also where ADR-0008's "no visitor IPs" stance is stated as a commitment).

Both are **static objects served at the root**, and both names are added to ADR-0007's reserved denylist alongside `abuse` and `legal`, which are already there — otherwise they collide with `/<username>` under ADR-0004's catch-all renderer.

Carried to the build (not decisions): authoring the documents, and **registering a DMCA designated agent** with the US Copyright Office — a $6 filing, and the precondition for safe harbour on a UGC product selling into the US.

## Considered options

**Takedown state**

- **Reuse `active` with an `inactiveReason`.** One flag, but the billing webhook and the moderation lever write the same attribute; the next `active=true` event silently un-suspends. Rejected — it reintroduces exactly the account state ADR-0002/ADR-0007 collapsed.
- **Hard-delete the Page.** Simplest render path, but destroys evidence, orphans the Username item, and makes a mistaken takedown unrecoverable.

**Report intake**

- **A `/report` form.** Better UX, but it is a new unauthenticated public write endpoint — a fresh abuse surface introduced by the abuse decision, needing its own rate limiting.
- **Contact on `/terms` only.** Cleanest pages, but a reporter has to go hunting and the safe-harbour posture wants a discoverable agent.

**Rate limiting**

- **One shared limiter in `core`** (DynamoDB token bucket, keyed per email / IP-hash / accountId). Coherent and easy to reason about, but ~2× the per-event cost on `/px` and `/r/*` to protect counts already declared approximate.
- **Floor only, no per-actor limit anywhere.** Cheapest and defensible under card-up-front, but leaves OTP-send able to bomb an arbitrary inbox — the one case with a named victim and a reputational cost we cannot buy back.
- **In-process token buckets** on `/px` / `/r/*`. Free, but state is per-instance and instances scale with the attack.
- **AWS WAF now.** The mechanism that actually works, at a floor three ADRs were built to avoid. Deferred to the named escalation instead.
- **A per-account claim rate limit.** A second mechanism guarding what delete-on-reclaim makes impossible.

**Phishing**

- **Reactive only.** Zero machinery, betting that paid-only signup keeps volume below the rate at which a blocklisting arrives. Kept as the base; the Safe Browsing check sits on top because domain reputation is the one asset a solo operator cannot restore by hand.
- **Split domains at v1.** Real blast-radius reduction, but reopens ADR-0004 and adds a second certificate and distribution. Held as escalation.

## Consequences

- **The renderer's visibility test is now `active && !suspendedAt`.** Any code path that gates public visibility must check both; checking `active` alone serves suspended Pages.
- **`suspendedAt` is the only attribute the billing webhook must never write**, and the only one whose write is paired with a CloudFront invalidation.
- **ADR-0007's claim transaction becomes two items** (write the new Username, delete the previously held one) and the Account gains a held-handle attribute. Its harvest condition gains the suspended-Page clause.
- **Suspended handles accumulate permanently.** At solo-operator volumes this is a rounding error; releasing one is a manual act.
- **A viral Page can be throttled by its own reserved concurrency.** This is the accepted price of a hard cost ceiling, and the first thing to raise when real traffic appears.
- **Counts remain inflatable** by anyone willing to script it. Unchanged from ADR-0008 and still not a billing input.
- **Link saves depend on a third-party API being reachable** — fails open, so the failure mode is a missed check, never a blocked creator.
- **Abuse handling is a founder's inbox.** There is no tooling, no rota, and no capacity story. This is the load-bearing assumption of the whole decision, and the first thing that breaks if the product grows.
- **The suspend/cancel/tombstone sequence is a runbook, not a feature** — three steps across DynamoDB, the merchant of record, and CloudFront. A small operator script is worth writing at build time so a takedown at 2am is one command rather than three consoles.
