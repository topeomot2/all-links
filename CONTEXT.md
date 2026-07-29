# All-Links

A cheap, serverless "link in bio" product: each Account has one public Page at `ourapp.com/<username>` listing a creator's Links, handed out as a single address instead of one link per platform.

## Language

**Account**:
The authenticated, billable entity. Owns login credentials and Subscription state, and owns exactly one Page in v1.
_Avoid_: User, Creator, Profile

**Page**:
The public artifact at `ourapp.com/<username>` — a display name, avatar, bio, Theme, and an ordered list of Links. A distinct concern from the Account (public presentation vs. private auth/billing), though 1:1 with it in v1.
_Avoid_: Site, Profile, Bio

**Link**:
An ordered, labeled destination shown on a Page (a label + a URL), carrying its own click count.
_Avoid_: Button, Item

**Username**:
The public handle that forms a Page's URL slug (`ourapp.com/<username>`). Unique across the system, lowercase-canonical, 3–30 characters of `a-z 0-9 - _`; changeable by Rename (a rename breaks old URLs in v1).
_Avoid_: Handle, Slug

**Claim**:
The act of taking a Username, and the record it creates. Happens before checkout, so availability is known before payment.
_Avoid_: Register, Reserve (Reserved means something else here)

**Hold**:
A Claim by an Account that has not yet paid. Lasts 7 days, after which a contending Claim may take the name — evaluated only on contention, never by a sweeper.
_Avoid_: Lock, Pending claim

**Reserved name**:
A Username no Account may ever Claim — a route, an authority word, or the brand. Distinct from *taken*, which means another Account currently holds it. Every *Static route*'s path is a Reserved name by derivation (ADR-0012); the rest are listed explicitly.
_Avoid_: Blocked, Banned

**Static route**:
A path the renderer answers from a fixed table in `core` — `/`, `/terms`, `/privacy`, `/robots.txt`, `/og-card.png`, plus redirects — without reading DynamoDB. Checked *before* the Username lookup, so a Static route always wins over a Page.
_Avoid_: Marketing page (only some are), Landing page (only `/` is)

**Rename**:
Changing an Account's Username. Releases the old name immediately; limited to once per 30 days.
_Avoid_: Change slug

**Theme**:
One of a small fixed set of preset visual styles a Page selects by id. Not customizable in v1.
_Avoid_: Skin, Style

**Subscription**:
The billing state of an Account — its lifecycle status (trialing, active, past_due, canceled), plan, and merchant-of-record references.
_Avoid_: Membership

**Suspension**:
A moderation state on a Page — set by a takedown, recorded as `suspendedAt`, and deliberately **not** a Subscription state. A Page is publicly visible only when it is both `active` (Subscription is good) and not suspended; the billing webhook never writes it, so paying again does not revive a suspended Page.
_Avoid_: Ban, Deactivation, Disabled

**Unfurl**:
The preview card another app (X, Discord, iMessage, WhatsApp) renders when a Page's URL is pasted into it — built from the Open Graph tags the renderer emits. A distinct surface from the Page itself: it is fetched **once per share** by a crawler, not once per view by a browser, which is why its costs and its image do not follow the Page's rules.
_Avoid_: Preview, Embed, Social card

**Brand card**:
The single static square image served as an Unfurl's `og:image` when a Page has no avatar. One asset for the whole system, not a per-Page artifact.
_Avoid_: Default image, Placeholder

> "Creator" is marketing language for the human behind an Account — avoid it as a model term.
