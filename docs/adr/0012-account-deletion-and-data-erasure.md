---
status: accepted
---

# ADR-0012 — Account deletion and data erasure

- **Date:** 2026-07-29
- **Decision ticket:** [S4 — Account deletion and data erasure](https://github.com/topeomot2/all-links/issues/23)
- **Builds on:** ADR-0001 (AWS serverless, Budgets alarm), ADR-0002 (merchant of record, `canceled` + 30 days), ADR-0003 (single-table item collection, Username item), ADR-0004 (`s-maxage=60`, no routine invalidation), ADR-0005 (Cognito holds the email), ADR-0006 (Lambdas + CDK), ADR-0007 (lazy harvest, claim `ConditionCheck`, delete-on-reclaim), ADR-0008 (no visitor IPs), ADR-0010 (suspension, handle tombstone, `/privacy`)
- **Amends:** ADR-0002, ADR-0003, ADR-0007, ADR-0010
- **Vocabulary:** see `CONTEXT.md` (Account, Page, Link, Username, Subscription, Suspension, Erasure)

## Context

ADR-0002 sells into **Europe**, ADR-0010 commits to shipping **`/privacy`**, and no ADR ever said what happens to an Account's data. Assembly (S1, §11) surfaced this as one of two things no ticket owned. It was an **omission, not a decision** — which is why it got a ticket rather than being left for the build to discover.

### The ticket asked one question; it was three

The framing "does v1 ship a delete path, or is it ruled out?" folds together three things with different urgency, different legal footing, and different answers:

| | What it is | Forced by |
|---|---|---|
| **Erasure on request** | GDPR Art. 17 — a subject asks, you erase | Law. **Does not require a button** — email plus a runbook is compliant |
| **Retention of lapsed accounts** | Data kept after it stops being needed | Law (Art. 5(1)(e), storage limitation). **Nobody has to ask** for this to be a problem |
| **Self-serve delete** | A dashboard affordance | Nothing. A product feature |

The ticket reads as being about the third. The third is the least important of the three, and **the second is the one that was actually unowned**: as inherited, an Account that cancels leaves its `email` in DynamoDB and in the Cognito user pool **forever**, for no purpose, with no mechanism that would ever remove it. ADR-0002 releases the *Username* after 30 days and is silent on everything else.

### What there is to erase

Small, and that is load-bearing for how little machinery this needs:

- **Cognito:** email, and the OTP sign-in records Cognito keeps.
- **DynamoDB Account item:** email, Subscription block (`morCustomerId`, `morSubscriptionId`, dates).
- **DynamoDB Page + Link items:** username, `displayName`, `bio`, `avatarWebp`, `themeId`, counters.
- **The merchant of record:** ADR-0002 made **Stripe the seller of record**, so Stripe is its own controller for the payment data and carries statutory tax retention we cannot and must not override. This *reduces* the exposure rather than adding to it.

**ADR-0008's "no visitor IPs, hashed or not"** means there is no analytics-side personal data at all — the counters are integers on the Page and Link items. A privacy commitment made for cost reasons turns out to have removed the hardest part of an erasure story before it was asked for.

## Decision

### 1. Three rights, three answers

| | v1 |
|---|---|
| Erasure on request | **Manual.** ADR-0010's `mailto:` inbox is the intake; the founder runs a runbook |
| Retention of lapsed accounts | **Automatic.** Erased 30 days after `canceled` |
| Self-serve delete button | **Out of scope** |
| Data export (Art. 20) | **Manual.** Same runbook, one extra command |

The manual posture is a stated decision, not a gap — which is the whole point, because `/privacy` has to be written against something.

### 2. One `eraseAccount`, two callers

Erasure-on-request and retention want **the same code**. They differ only in who calls it, so they are one function:

```
                eraseAccount(accountId)
               /                       \
   EventBridge Scheduler          founder, by hand
   (retention, +30d)              (Art. 17 request)
```

Written as two implementations they would drift, and the manual one — invoked rarely, under time pressure, by one person — is exactly the one that would rot. A third caller (a self-serve button) can be added later without touching the eraser.

### 3. The retention clock is a one-shot schedule

The billing webhook, on `canceled`, creates a **one-shot EventBridge Scheduler entry** at `now + 30d` targeting the eraser. On a resubscribe, it deletes the schedule.

**EventBridge Scheduler bills 14,000,000 invocations per month free**, then $1.00/M. At one schedule per churned account this is structurally free — not "cheap", but *unreachable*. ADR-0001's cost constraint is untouched.

This is a scheduled job, which ADR-0007 pointedly refused for the username hold. The refusal stands and does not apply: ADR-0007 rejected a **sweeper** — a periodic scan looking for work — because the work could be done lazily at the moment of contention instead. There is no contention event for "nobody ever came back," so there is nothing to be lazy at. A one-shot timer attached to a specific account is a different mechanism with a different failure mode.

### 4. What erasure does, in order

```
eraseAccount(accountId):
  1. cancel Subscription at the merchant of record
  2. delete the item collection    PK=ACCOUNT#<id>   (Account, Page, all Links)
  3. Cognito AdminDeleteUser(accountId)
  4. the Username item             — see §5
```

**Step 1 comes first because `morSubscriptionId` lives on the item step 2 deletes.** Getting this backwards leaves a live subscription with nothing pointing at it, billing a card for a page that no longer exists.

**No CloudFront invalidation.** The Page vanishes, the cached document expires under ADR-0004's `s-maxage=60`, and the path then serves the ADR-0004 placeholder. ADR-0010's claim that **suspension is the only invalidation in the system** survives — deliberately, because that claim is what keeps ADR-0004's $0-invalidation cost model true.

### 5. The Username item is the whole crux

ADR-0010 burns a suspended Page's handle **until manually released**, precisely so a bad actor cannot return with a fresh email. An erasure request from that actor is the same attack wearing a legal hat.

The two are not actually in conflict, once the owner reference comes off:

```
not suspended  →  Delete Username                     handle returns to the pool
suspended      →  Update Username
                     REMOVE ownerAccountId
                     SET    tombstonedAt              handle stays burnt,
                                                      zero personal data retained
```

**A burnt handle stops being an account record and becomes a denylist entry** — the runtime sibling of ADR-0007's frozen reserved Set in `core`. What remains is a name string and a timestamp, linked to nobody. The erasure is honoured in full; the tombstone survives it. No Art. 17(3) exemption has to be argued, which matters when the person arguing it is a solo founder answering mail.

**`tombstonedAt` is written at suspension time, not at erasure time.** ADR-0010 implemented "tombstone the handle" as a harvest clause reading `suspendedAt` on the **Page** — but erasure deletes the Page, so that clause cannot survive its own erasure path. Moving the flag onto the Username item makes the harvest check **the item it is already writing**:

```
CLAIM      put Username
             attribute_not_exists(PK)
             OR (holder inactive AND claimedAt < now - 7d
                 AND attribute_not_exists(tombstonedAt))
```

Erasure then only strips `ownerAccountId`, and re-asserts `tombstonedAt` idempotently. This is a straight simplification of ADR-0010 — one fewer item read on the claim path — and it removes one of the three cross-item reads S1 §11.1 flagged as not expressible in a single condition.

### 6. Erasure is webhook-proof, structurally

ADR-0007 has the billing webhook **create** the Page if it completes second. A late `canceled` or `payment_failed` event arriving after erasure could therefore rebuild an account that was just deleted — a resurrection bug with a legal edge to it.

It cannot happen. ADR-0007 guards that creation with `ConditionCheck Username.ownerAccountId == me`, and **both** erasure branches defeat it: the delete branch removes the item, the tombstone branch removes the attribute. Nothing needs to be added.

Recorded here explicitly so that nobody later "fixes" the webhook into an unconditional upsert and silently reopens it.

### 7. Money

Erasure **cancels the subscription immediately**. Charging for a page that has been deleted is indefensible on the same grounds ADR-0010 gave for cancelling on suspension.

**Voluntary deletion forfeits the remainder of the term. No automatic refund; the founder may refund case-by-case.** R2 established that the **fixed** per-transaction fee is 18–30% of a $20 charge, and the processor does not return it on a refund — so a full refund on an annual plan is an out-of-pocket loss, not merely forgone revenue. A stated pro-rata obligation is not something a $20/yr price point can absorb; discretion covers the sympathetic case without creating the obligation. This goes in `/terms`.

### 8. What `/privacy` must say

The reason this ADR exists is so the policy can be written. It must state:

- **What is held:** email, username, display name, bio, avatar, links, aggregate counts.
- **No visitor IPs** — ADR-0008's commitment, restated as a promise to readers.
- **Stripe is the merchant of record** and an independent controller for payment data, with its own retention.
- **Retention:** erased 30 days after cancellation, automatically.
- **Erasure and export on request** by email, answered within 30 days.
- **Suspended handles remain reserved after erasure**, holding no personal data. Say it plainly rather than being caught doing it quietly.

## Considered options

- **DynamoDB TTL + a Streams handler.** Stamp a TTL attribute on every item at cancellation; DynamoDB deletes them free; a Stream handler catches the Account item's service-delete and removes the Cognito user. Genuinely free and needs no scheduler. Rejected on three counts: AWS documents TTL deletion as landing "**within a few days**" of expiry — unbounded, and a retention promise in `/privacy` should not be written against an SLA that vague; it adds a stream and a fourth Lambda to the table; and **the manual path cannot reuse it**, so the two erasure paths are written twice and drift. Being free was never the constraint.
- **Erase immediately on `canceled`, no timer at all.** Zero new mechanism — the webhook already fires. Rejected because it is not actually free: deleting the collection makes the GSI1 lookup miss, so the handle returns to the market instantly and the URL starts serving the "this name is available" placeholder. That reverses ADR-0002's 30-day reservation and collapses ADR-0004's two deliberately distinct negative-path bodies into one.
- **A self-serve delete button.** Rejected for v1: an irreversible destructive action needs confirmation UX, must cancel the subscription inline, and has to be blocked for suspended Accounts or it becomes a way to launder a burnt handle. It automates the *rarer* of the two rights — the retention case fires without anyone asking, and now does so automatically. Add it when there is evidence anyone wants it.
- **Always delete the Username item, suspended or not**, on the grounds that ADR-0010's own card-up-front argument makes reclaiming a handle cost a fresh subscription. Rejected: it reverses a decision ADR-0010 made explicitly, for a saving of one conditional.
- **Exempt suspended Accounts from erasure**, leaning on Art. 17(3)(e) (retention for legal claims). Rejected: it retains real personal data indefinitely on exactly the accounts most likely to escalate, and puts a solo founder into a legal argument by email. The owner-less tombstone gets the same protection with nothing retained.
- **Self-serve JSON export.** The dashboard already runs `Query PK=ACCOUNT#<id>` to render itself, so the endpoint is thin. Rejected as more automation for portability than for erasure, which is the more-exercised right and was just left manual. Inconsistent to ship the lesser one first.
- **Say nothing about portability.** Rejected — `/privacy` is being authored anyway, and one addressing Art. 17 while silent on Art. 20 reads as incomplete to the European users ADR-0002 targets.

## Consequences

**Positive**

- **The unbounded-retention gap is closed by default**, for every churned account, with no user action and no founder action.
- **One eraser, three future callers.** The manual path and the automatic path cannot diverge because they are the same function.
- **ADR-0010's tombstone gets cheaper**, not just compatible: the harvest condition drops a cross-item read, taking a bite out of S1 §11.1.
- **Erasure needs no new invalidation**, so ADR-0004's cost model and ADR-0010's "only invalidation in the system" both stand unchanged.
- ADR-0008's no-IPs stance, taken for cost, turns out to remove the hardest category of erasure entirely.

**Costs, accepted**

- **Erasure on request is a human in a loop**, with a 30-day statutory clock and no tooling behind it. This is the same load-bearing assumption ADR-0010 stated for abuse handling, and it breaks at the same point: growth.
- **The eraser is unattended destructive code.** A bug in the collection query erases the wrong account, irreversibly, with no undo — DynamoDB point-in-time recovery is the only net, and restoring it is not a runbook anyone has. Worth a build-time test against a real dev table (§10).
- **A one-shot schedule per churned account** is state living outside DynamoDB, and a resubscribe must remember to delete it. A leaked schedule erases a *paying* account. The eraser must therefore re-check subscription status on entry and no-op if the Account is active — a cheap guard against the one failure mode that matters.
- **No refund on voluntary deletion** will occasionally read as mean at $20/yr. Discretion is the release valve.
- **A creator who deletes has no recovery**, unlike a cancellation, which reserves for 30 days. Deletion must say so at the point of request.

**Downstream constraints**

- **ADR-0002:** the lifecycle table gains a terminal row — `canceled` + 30 days now **erases the Account**, not merely releases the Username. Its A1 constraint ("a username reservation whose release is 30 days after cancellation") widens to the whole collection.
- **ADR-0003:** the Username item gains **`tombstonedAt`**, and `ownerAccountId` becomes **removable** rather than fixed for the item's life. Erasure is a new access pattern: `Query PK=ACCOUNT#<id>` → `BatchWriteItem` delete.
- **ADR-0007:** the claim condition gains `attribute_not_exists(tombstonedAt)`. Its "no scheduled job" claim now holds for the *hold*, not for the account lifecycle.
- **ADR-0010:** step 3 of the suspend sequence becomes a concrete write (`SET tombstonedAt` on the Username item) rather than a clause about the Page; the tombstone is specified to survive erasure with the owner stripped.
- **ADR-0006 / CDK:** one new Lambda (`eraser`) and an EventBridge Scheduler schedule group with an IAM role permitted to invoke it.
- **`/privacy` and `/terms`** (§10 build checklist) now have a specified list of claims to be written against, including the refund line.
- **The runbook** ADR-0010 called for gains two commands: `erase-account <accountId>` and `export-account <accountId>`.
