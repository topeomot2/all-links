import type { MeResponse } from '@all-links/core/api-contract';
import { describe, expect, it } from 'vitest';

import { checkoutUsername, createApi, nextStep, SignedOutError } from './api.js';
import { CognitoError, createCognito, submitEmail, type Cognito } from './cognito.js';
import { createSession, tokenExpiry, type Storage } from './session.js';

/** A fake Cognito endpoint: answers by `X-Amz-Target`, records every call. */
function cognitoEndpoint(answers: Record<string, () => { status: number; body: object }>) {
  const calls: { action: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const action = String((init.headers as Record<string, string>)['x-amz-target']).split('.')[1]!;
    calls.push({ action, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const answer = answers[action]?.() ?? { status: 500, body: { __type: 'Unscripted' } };
    return new Response(JSON.stringify(answer.body), { status: answer.status });
  }) as unknown as typeof fetch;

  const cognito = createCognito({ region: 'us-east-1', userPoolClientId: 'client' }, fetchImpl);
  return { calls, cognito };
}

const ok = (body: object) => () => ({ status: 200, body });
const fail = (type: string) => () => ({
  status: 400,
  body: { __type: `com.amazonaws#${type}`, message: type },
});

describe('submitting an email', () => {
  it('signs a new email up, lowercased, with no password', async () => {
    const { calls, cognito } = cognitoEndpoint({ SignUp: ok({ Session: 's1' }) });

    const step = await submitEmail(cognito, '  Jane@Example.com ');

    expect(step).toEqual({ kind: 'confirm-signup', email: 'jane@example.com', session: 's1' });
    expect(calls[0]?.body).toEqual({
      ClientId: 'client',
      Username: 'jane@example.com',
      UserAttributes: [{ Name: 'email', Value: 'jane@example.com' }],
    });
    expect(calls[0]?.body).not.toHaveProperty('Password');
  });

  it('starts an EMAIL_OTP sign-in when the email already exists', async () => {
    const { calls, cognito } = cognitoEndpoint({
      SignUp: fail('UsernameExistsException'),
      InitiateAuth: ok({ ChallengeName: 'EMAIL_OTP', Session: 's2' }),
    });

    expect(await submitEmail(cognito, 'jane@example.com')).toEqual({
      kind: 'sign-in',
      email: 'jane@example.com',
      session: 's2',
    });
    expect(calls[1]?.body).toMatchObject({
      AuthFlow: 'USER_AUTH',
      AuthParameters: { USERNAME: 'jane@example.com', PREFERRED_CHALLENGE: 'EMAIL_OTP' },
    });
  });

  it('resends the confirmation code to an email that never finished signing up', async () => {
    const { calls, cognito } = cognitoEndpoint({
      SignUp: fail('UsernameExistsException'),
      InitiateAuth: fail('UserNotConfirmedException'),
      ResendConfirmationCode: ok({}),
    });

    expect(await submitEmail(cognito, 'jane@example.com')).toEqual({
      kind: 'confirm-signup',
      email: 'jane@example.com',
    });
    expect(calls.map((c) => c.action)).toEqual([
      'SignUp',
      'InitiateAuth',
      'ResendConfirmationCode',
    ]);
  });

  it('surfaces any other failure as a CognitoError carrying its type', async () => {
    const { cognito } = cognitoEndpoint({ SignUp: fail('TooManyRequestsException') });

    await expect(submitEmail(cognito, 'a@b.c')).rejects.toMatchObject({
      type: 'TooManyRequestsException',
    });
  });
});

describe('entering the code', () => {
  it('confirms a sign-up and trades its session for tokens — no second code', async () => {
    const { calls, cognito } = cognitoEndpoint({
      ConfirmSignUp: ok({ Session: 'after-confirm' }),
      InitiateAuth: ok({ AuthenticationResult: { AccessToken: 'a', RefreshToken: 'r' } }),
    });

    expect(await cognito.confirmSignUp('jane@example.com', '123456', 's1')).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
    });
    expect(calls[0]?.body).toMatchObject({ ConfirmationCode: '123456', Session: 's1' });
    expect(calls[1]?.body).toMatchObject({ AuthFlow: 'USER_AUTH', Session: 'after-confirm' });
  });

  it('answers the EMAIL_OTP challenge for a returning user', async () => {
    const { calls, cognito } = cognitoEndpoint({
      RespondToAuthChallenge: ok({ AuthenticationResult: { AccessToken: 'a', RefreshToken: 'r' } }),
    });

    await cognito.answerSignIn('jane@example.com', '654321', 's2');

    expect(calls[0]?.body).toEqual({
      ClientId: 'client',
      ChallengeName: 'EMAIL_OTP',
      Session: 's2',
      ChallengeResponses: { USERNAME: 'jane@example.com', EMAIL_OTP_CODE: '654321' },
    });
  });

  it('reports a wrong code by its type', async () => {
    const { cognito } = cognitoEndpoint({ RespondToAuthChallenge: fail('CodeMismatchException') });

    const err = await cognito.answerSignIn('a@b.c', '000000', 's').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CognitoError);
    expect((err as CognitoError).type).toBe('CodeMismatchException');
  });
});

const jwt = (exp: number) =>
  `h.${btoa(JSON.stringify({ exp })).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')}.s`;

function memoryStorage(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function fakeCognito(refresh: () => Promise<{ accessToken: string }>) {
  const revoked: string[] = [];
  const cognito = {
    refresh,
    revoke: (t: string) => {
      revoked.push(t);
      return Promise.resolve();
    },
  } as unknown as Cognito;
  return { cognito, revoked };
}

describe('the session', () => {
  const NOW = 1_000_000;

  it('reads a JWT expiry, and treats garbage as already expired', () => {
    expect(tokenExpiry(jwt(1234))).toBe(1234);
    expect(tokenExpiry('nope')).toBe(0);
  });

  it('keeps the refresh token in storage and the access token in memory only', () => {
    const storage = memoryStorage();
    createSession(fakeCognito(() => Promise.reject()).cognito, storage).store({
      accessToken: jwt(NOW + 3600),
      refreshToken: 'r',
    });

    expect([...storage.data.values()]).toEqual(['r']);
  });

  it('reuses a fresh access token without calling Cognito', async () => {
    let refreshed = 0;
    const session = createSession(
      fakeCognito(() => {
        refreshed += 1;
        return Promise.resolve({ accessToken: 'x' });
      }).cognito,
      memoryStorage(),
      () => NOW,
    );
    session.store({ accessToken: jwt(NOW + 3600), refreshToken: 'r' });

    expect(await session.accessToken()).toBe(jwt(NOW + 3600));
    expect(refreshed).toBe(0);
  });

  it('refreshes a token about to expire, so a reload survives for ~60 days', async () => {
    const storage = memoryStorage();
    storage.setItem('all-links.refreshToken', 'r');
    const session = createSession(
      fakeCognito(() => Promise.resolve({ accessToken: 'new' })).cognito,
      storage,
      () => NOW,
    );

    expect(session.hasSession()).toBe(true);
    expect(await session.accessToken()).toBe('new');
  });

  it('signs out when the refresh token is rejected', async () => {
    const storage = memoryStorage();
    storage.setItem('all-links.refreshToken', 'r');
    const session = createSession(
      fakeCognito(() => Promise.reject(new Error('revoked'))).cognito,
      storage,
      () => NOW,
    );

    expect(await session.accessToken()).toBeUndefined();
    expect(session.hasSession()).toBe(false);
  });

  it('revokes the refresh token on sign-out', async () => {
    const storage = memoryStorage();
    const { cognito, revoked } = fakeCognito(() => Promise.reject());
    const session = createSession(cognito, storage);
    session.store({ accessToken: 'a', refreshToken: 'r' });

    await session.signOut();

    expect(revoked).toEqual(['r']);
    expect(session.hasSession()).toBe(false);
  });
});

describe('the api client', () => {
  const NOW = 1_000_000;
  const me: MeResponse = { account: { accountId: 'a', email: 'e' }, links: [] };

  function signedIn() {
    const session = createSession(
      fakeCognito(() => Promise.reject()).cognito,
      memoryStorage(),
      () => NOW,
    );
    session.store({ accessToken: jwt(NOW + 3600), refreshToken: 'r' });
    return session;
  }

  it('sends the token in x-authorization, with no cookies', async () => {
    let seen: RequestInit | undefined;
    const api = createApi(signedIn(), (async (_: string, init: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify(me));
    }) as unknown as typeof fetch);

    expect(await api.me()).toEqual(me);
    expect(seen?.headers).toEqual({ 'x-authorization': `Bearer ${jwt(NOW + 3600)}` });
    expect(seen?.credentials).toBe('omit');
  });

  it('signs out on a 401', async () => {
    const session = signedIn();
    const api = createApi(session, (async () =>
      new Response('{}', { status: 401 })) as unknown as typeof fetch);

    await expect(api.me()).rejects.toBeInstanceOf(SignedOutError);
    expect(session.hasSession()).toBe(false);
  });
});

describe('post-auth routing (spec §6.1)', () => {
  const account = { accountId: 'a', email: 'e' };
  const page = {
    username: 'jane',
    displayName: 'Jane',
    themeId: 'slate',
    active: true,
    suspended: false,
    pageViewCount: 0,
  };

  it('sends an Account with no Username to the claim', () => {
    expect(nextStep({ account, links: [] })).toBe('claim');
  });

  it('sends an Account holding a Username back to checkout', () => {
    expect(nextStep({ account: { ...account, heldUsername: 'jane' }, links: [] })).toBe('checkout');
  });

  it('sends an active Account to the dashboard', () => {
    expect(nextStep({ account: { ...account, heldUsername: 'jane' }, page, links: [] })).toBe(
      'dashboard',
    );
  });

  it('sends a suspended but paid Account to the dashboard, to be told so', () => {
    expect(nextStep({ account, page: { ...page, suspended: true }, links: [] })).toBe('dashboard');
  });

  it('sends a lapsed Account back to checkout, not the dashboard', () => {
    const lapsed = { account, page: { ...page, active: false }, links: [] };

    expect(nextStep(lapsed)).toBe('checkout');
    expect(checkoutUsername(lapsed)).toBe('jane');
  });
});
