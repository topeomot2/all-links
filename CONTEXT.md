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
The public handle that forms a Page's URL slug (`ourapp.com/<username>`). Unique across the system; changeable (a rename breaks old URLs in v1).
_Avoid_: Handle, Slug

**Theme**:
One of a small fixed set of preset visual styles a Page selects by id. Not customizable in v1.
_Avoid_: Skin, Style

**Subscription**:
The billing state of an Account — its lifecycle status (trialing, active, past_due, canceled), plan, and merchant-of-record references.
_Avoid_: Membership

> "Creator" is marketing language for the human behind an Account — avoid it as a model term.
