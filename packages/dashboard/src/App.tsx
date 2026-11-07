import type { MeResponse } from '@all-links/core/api-contract';
import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';

import { createApi, nextStep, SignedOutError } from './api.js';
import { CognitoError, createCognito, submitEmail, type EmailStep } from './cognito.js';
import type { DashboardConfig } from './config.js';
import { createSession } from './session.js';

type View =
  | { kind: 'loading' }
  | { kind: 'email'; notice?: string }
  | { kind: 'code'; step: EmailStep }
  | { kind: 'signed-in'; me: MeResponse }
  | { kind: 'error'; message: string };

/**
 * The dashboard shell: email → one-time code → the signed-in Account's state,
 * read through the api. Claim (T9), checkout (T12) and the editor (T10/T11)
 * hang off the routing in `nextStep`.
 */
export function App({ config }: { config: DashboardConfig }) {
  const cognito = useMemo(() => createCognito(config), [config]);
  const session = useMemo(() => createSession(cognito, window.localStorage), [cognito]);
  const api = useMemo(() => createApi(session), [session]);

  const [view, setView] = useState<View>({ kind: 'loading' });

  const loadMe = useCallback(async () => {
    try {
      setView({ kind: 'signed-in', me: await api.me() });
    } catch (err) {
      if (err instanceof SignedOutError) setView({ kind: 'email' });
      else setView({ kind: 'error', message: messageOf(err) });
    }
  }, [api]);

  useEffect(() => {
    if (session.hasSession()) void loadMe();
    else setView({ kind: 'email' });
  }, [session, loadMe]);

  const signOut = async () => {
    await session.signOut();
    setView({ kind: 'email' });
  };

  return (
    <main>
      <h1>All-Links</h1>
      {view.kind === 'loading' && <p className="note">Loading…</p>}
      {view.kind === 'email' && (
        <EmailForm
          notice={view.notice}
          onSubmit={async (email) => setView({ kind: 'code', step: await submitEmail(cognito, email) })}
        />
      )}
      {view.kind === 'code' && (
        <CodeForm
          email={view.step.email}
          onBack={() => setView({ kind: 'email' })}
          onSubmit={async (code) => {
            const { step } = view;
            const tokens =
              step.kind === 'confirm-signup'
                ? await cognito.confirmSignUp(step.email, code, step.session)
                : await cognito.answerSignIn(step.email, code, step.session);
            session.store(tokens);
            await loadMe();
          }}
        />
      )}
      {view.kind === 'signed-in' && <SignedIn me={view.me} onSignOut={signOut} />}
      {view.kind === 'error' && (
        <>
          <p role="alert">{view.message}</p>
          <button type="button" onClick={() => void loadMe()}>
            Try again
          </button>
        </>
      )}
    </main>
  );
}

function EmailForm({
  notice,
  onSubmit,
}: {
  notice?: string | undefined;
  onSubmit: (email: string) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const { busy, error, run } = useSubmit();

  return (
    <form onSubmit={(e) => run(e, () => onSubmit(email))}>
      {notice && <p className="note">{notice}</p>}
      <label htmlFor="email">Email</label>
      <input
        id="email"
        type="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <button type="submit" disabled={busy}>
        {busy ? 'Sending…' : 'Email me a code'}
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

function CodeForm({
  email,
  onSubmit,
  onBack,
}: {
  email: string;
  onSubmit: (code: string) => Promise<void>;
  onBack: () => void;
}) {
  const [code, setCode] = useState('');
  const { busy, error, run } = useSubmit();

  return (
    <form onSubmit={(e) => run(e, () => onSubmit(code.trim()))}>
      <p>
        We sent a code to <strong>{email}</strong>.
      </p>
      <label htmlFor="code">Code</label>
      <input
        id="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]{6,8}"
        required
        value={code}
        onChange={(e) => setCode(e.target.value)}
      />
      <button type="submit" disabled={busy}>
        {busy ? 'Checking…' : 'Sign in'}
      </button>
      <button type="button" className="link" onClick={onBack}>
        Use a different email
      </button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

function SignedIn({ me, onSignOut }: { me: MeResponse; onSignOut: () => Promise<void> }) {
  const step = nextStep(me);

  return (
    <section>
      <p className="note">Signed in as {me.account.email}</p>
      {step === 'claim' && <p>Next: choose your username. (Claiming arrives with T9.)</p>}
      {step === 'checkout' && (
        <p>
          <strong>{me.account.heldUsername}</strong> is held for you. Next: start your trial.
          (Checkout arrives with T12.)
        </p>
      )}
      {step === 'dashboard' && me.page && (
        <>
          <p>
            Your Page: <a href={`/${me.page.username}`}>/{me.page.username}</a>
            {!me.page.active && ' — not live'}
            {me.page.suspended && ' — suspended'}
          </p>
          <p className="note">
            {me.links.length} {me.links.length === 1 ? 'Link' : 'Links'} ·{' '}
            {me.page.pageViewCount} views
          </p>
        </>
      )}
      <button type="button" onClick={() => void onSignOut()}>
        Sign out
      </button>
    </section>
  );
}

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const run = (event: FormEvent, action: () => Promise<void>) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    action()
      .catch((err: unknown) => setError(messageOf(err)))
      .finally(() => setBusy(false));
  };

  return { busy, error, run };
}

function messageOf(err: unknown): string {
  if (err instanceof CognitoError) {
    switch (err.type) {
      case 'CodeMismatchException':
        return 'That code is not right. Check the email and try again.';
      case 'ExpiredCodeException':
        return 'That code has expired. Go back and request a new one.';
      case 'NotAuthorizedException':
        return 'That code has expired or was used already. Go back and request a new one.';
      case 'LimitExceededException':
      case 'TooManyRequestsException':
        return 'Too many attempts. Wait a little and try again.';
    }
  }
  return 'Something went wrong. Please try again.';
}
