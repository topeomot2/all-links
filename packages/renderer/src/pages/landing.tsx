import { DASHBOARD_PATH } from '@all-links/core';

import { MarketingDocument } from './marketing.js';

/**
 * The front door (ADR-0013).
 *
 * Its whole reason to exist is that `/` used to fall through to the Username
 * lookup and answer *"this name is available — claim it"* — a product with one
 * funnel offering visitors the empty username. Pricing is stated **inline**
 * rather than on a route of its own; `/pricing` is a 302 to the anchor below.
 *
 * The copy here is a working draft. **#31 authors the real pitch** and drops it
 * into this component — the routing, the anchor and the CTA targets are the
 * contract, and none of them move when the words change.
 */
export interface LandingDocumentProps {
  /** The bare host, for showing what an address looks like — `linkix.io`. */
  siteHost: string;
  canonical: string;
  cardUrl: string;
}

export function LandingDocument({ siteHost, canonical, cardUrl }: LandingDocumentProps) {
  return (
    <MarketingDocument
      title="One link for everything you make"
      description={DESCRIPTION}
      canonical={canonical}
      cardUrl={cardUrl}
      css={LANDING_CSS}
    >
      <main>
        <h1>One link for everything you make.</h1>
        <p class="lede">
          Your links, your face, your name — on one fast page at{' '}
          <span class="address">{siteHost}/yourname</span>. Hand out one address instead of five.
        </p>
        <p>
          <a class="cta" href={DASHBOARD_PATH}>
            Claim your name
          </a>
        </p>

        <h2>What you get</h2>
        <ul class="points">
          <li>A page that loads instantly — no scripts, no cookie banner, no tracking of visitors.</li>
          <li>As many links as you like, in the order you choose.</li>
          <li>Click and view totals, so you know what people actually tap.</li>
          <li>A handful of themes. Pick one, change it whenever.</li>
        </ul>

        {/*
          The anchor `/pricing` redirects to. Prices are stated in two places —
          here and the Stripe catalogue — with nothing enforcing agreement
          between them (ADR-0013, checklist item 15). Change both.
        */}
        <h2 id="pricing">Pricing</h2>
        <p>Five days free, then whichever suits you. No free tier, no ads, no upsells.</p>
        <ul class="plans">
          <li class="plan">
            <span class="plan-name">Annual</span>
            <span class="price">$20</span>
            <span class="per">per year — about $1.67 a month</span>
          </li>
          <li class="plan">
            <span class="plan-name">Monthly</span>
            <span class="price">$2.99</span>
            <span class="per">per month</span>
          </li>
        </ul>
        <p class="fine">
          The trial asks for a card up front and starts your page immediately. Cancel any time — see{' '}
          <a href="/terms">Terms</a>.
        </p>
        <p>
          <a class="cta" href={DASHBOARD_PATH}>
            Start your five days
          </a>
        </p>
      </main>
    </MarketingDocument>
  );
}

/** `og:description` — the sentence an unfurl of the front door shows. */
const DESCRIPTION = 'One page for all your links, at your own short address. $20 a year.';

const LANDING_CSS = `
h1{font-size:2.25rem;line-height:1.15;margin:0 0 1rem;color:var(--text)}
.lede{font-size:1.125rem;margin-bottom:2rem}
.address{color:var(--text);font-weight:600;white-space:nowrap}
.points{margin:0;padding-left:1.25rem;color:var(--muted)}
.points li{margin-bottom:0.5rem}
.plans{list-style:none;margin:1.5rem 0;padding:0;display:grid;gap:1rem;
grid-template-columns:repeat(auto-fit,minmax(13rem,1fr))}
.plan{
padding:1.25rem;
border-radius:0.75rem;
background:var(--surface);
border:1px solid color-mix(in srgb,var(--accent) 25%,transparent);
display:grid;
gap:0.25rem;
}
.plan-name{font-size:0.8125rem;text-transform:uppercase;letter-spacing:0.08em;color:var(--muted)}
.price{font-size:2rem;font-weight:700;color:var(--text);line-height:1.1}
.per{font-size:0.875rem;color:var(--muted)}
.fine{font-size:0.875rem}
`;
