import type { ComponentChildren } from 'preact';

import { MarketingDocument } from './marketing.js';

/**
 * `/terms` and `/privacy` — the policy surface a UGC product needs before it
 * can suspend anyone or answer a data request (spec §8, §6.8).
 *
 * The prose here is a **working draft, not reviewed**. #31 authors both and
 * puts them through legal review before launch (pre-build checklist item 7);
 * these components are the shape it lands in, and neither an effective date
 * nor a word of the copy changes anything about routing. What *is* settled is
 * the ground each must cover — Terms carries the acceptable-use rules the
 * suspend lever enforces and the no-refund-on-deletion line, and Privacy makes
 * the six claims §6.8 specifies. Those headings are why the drafts are here at
 * all rather than an empty page.
 */
interface LegalDocumentProps {
  title: string;
  description: string;
  canonical: string;
  cardUrl: string;
  children: ComponentChildren;
}

function LegalDocument({ title, description, canonical, cardUrl, children }: LegalDocumentProps) {
  return (
    <MarketingDocument
      title={title}
      description={description}
      canonical={canonical}
      cardUrl={cardUrl}
      css={LEGAL_CSS}
    >
      <main>
        <h1>{title}</h1>
        {children}
      </main>
    </MarketingDocument>
  );
}

export interface PolicyDocumentProps {
  /** The abuse mailbox (ADR-0010) — the only intake channel, so it is also the
   * address a takedown, an erasure request and an export request arrive at. */
  abuseEmail: string;
  canonical: string;
  cardUrl: string;
}

export function TermsDocument({ abuseEmail, canonical, cardUrl }: PolicyDocumentProps) {
  return (
    <LegalDocument
      title="Terms of Service"
      description="The rules for using the service, and what happens when they are broken."
      canonical={canonical}
      cardUrl={cardUrl}
    >
      <p>
        These terms cover your use of the service. By claiming a name and publishing a page, you
        agree to them.
      </p>

      <h2>Your account</h2>
      <p>
        One account holds one page, at one name. You are responsible for the address you sign up
        with and for everything published under your name. You must be old enough to enter a
        contract where you live.
      </p>

      <h2>Acceptable use</h2>
      <p>Do not use a page to publish, link to, or promote:</p>
      <ul>
        <li>anything unlawful where you or your visitors are;</li>
        <li>sexual content involving minors, or any depiction of it;</li>
        <li>malware, phishing, or links that misrepresent where they lead;</li>
        <li>harassment of a person, or content that exists to threaten or defame;</li>
        <li>impersonation of another person, business or organisation;</li>
        <li>content you have no right to publish.</li>
      </ul>
      <p>
        We may suspend a page for breaking these rules, and we do not have to warn you first. A
        suspended page stops being publicly visible, and its name stays out of circulation
        afterwards rather than returning to the pool.
      </p>

      <h2>Reports</h2>
      <p>
        Reports go to <a href={`mailto:${abuseEmail}`}>{abuseEmail}</a>, which is read by a person.
        Include the address of the page and what is wrong with it. Copyright complaints should
        identify the work and your authority to act for its owner.
      </p>

      <h2>Payment</h2>
      <p>
        The trial is five days and asks for a card up front. After it, the plan you chose renews
        until you cancel. Prices are shown at checkout and on the home page; if they change, the
        change applies from your next renewal, not the current term.
      </p>
      <p>
        Cancelling stops the next renewal and leaves your page up for the rest of the term you have
        paid for. <strong>Deleting your account forfeits the remainder of the term.</strong> Refunds
        are not automatic in either case — write to us and we will look at it.
      </p>

      <h2>Ending it</h2>
      <p>
        You can stop at any time. We can end an account for a breach of the acceptable-use rules
        above, or if we stop offering the service — in which case we will say so by email. When an
        account ends, its data is removed on the schedule set out in the{' '}
        <a href="/privacy">Privacy Policy</a>.
      </p>

      <h2>The service as it is</h2>
      <p>
        The service is provided as it stands, without a promise that it will always be available or
        error-free. Nothing here limits rights you have by law that cannot be waived.
      </p>

      <h2>Changes</h2>
      <p>
        These terms may change. Material changes will be announced by email before they take effect.
      </p>
    </LegalDocument>
  );
}

export function PrivacyDocument({ abuseEmail, canonical, cardUrl }: PolicyDocumentProps) {
  return (
    <LegalDocument
      title="Privacy Policy"
      description="What is held, what is not, and how to have it removed."
      canonical={canonical}
      cardUrl={cardUrl}
    >
      <p>This is what we hold, why, and how to get rid of it.</p>

      <h2>What we hold</h2>
      <ul>
        <li>Your email address — it is how you sign in, and the only way we can reach you.</li>
        <li>Your page: the name you claimed, your display name, bio, avatar, links and theme.</li>
        <li>
          Totals — how many times your page was viewed and each link was tapped. Numbers only.
        </li>
      </ul>

      <h2>What we do not hold</h2>
      <p>
        <strong>We do not record the IP addresses of people who visit your page</strong>, and we do
        not profile them, set cookies on them, or hand them to an analytics service. A page view is
        a number going up by one. There is nothing to hand over, because nothing is kept.
      </p>

      <h2>Payments</h2>
      <p>
        Payments are handled by Stripe as merchant of record. We never see your card details. Stripe
        is an independent controller of the data it collects to take your payment, under its own
        privacy policy and its own retention periods, which we do not set.
      </p>

      <h2>How long we keep it</h2>
      <p>
        While you have an account, we keep the above. If your subscription is cancelled, your page
        stops being visible and{' '}
        <strong>the account and everything it owns is erased 30 days later</strong> — the record in
        our database, the login, and the claim on your name.
      </p>

      <h2>Getting a copy, or getting it deleted</h2>
      <p>
        Write to <a href={`mailto:${abuseEmail}`}>{abuseEmail}</a> from the address you signed up
        with. We will export your data or erase it <strong>within 30 days</strong>. Erasure is not
        reversible and forfeits the remainder of a paid term (see <a href="/terms">Terms</a>).
      </p>

      <h2>Suspended names</h2>
      <p>
        If a page was suspended for breaking the rules, its name stays reserved after the account is
        erased, so it cannot be taken again with a fresh email. The reserved name holds{' '}
        <strong>no personal data</strong> — not your email, not your account, nothing but the fact
        that the name is not available.
      </p>

      <h2>Changes</h2>
      <p>Material changes to this policy will be announced by email before they take effect.</p>
    </LegalDocument>
  );
}

const LEGAL_CSS = `
h1{font-size:1.875rem;margin:0 0 1.5rem;color:var(--text)}
ul{margin:0 0 1rem;padding-left:1.25rem;color:var(--muted)}
li{margin-bottom:0.375rem}
strong{color:var(--text)}
`;
