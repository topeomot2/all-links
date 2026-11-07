/**
 * A thin client for the five Cognito calls the dashboard makes. The browser
 * talks to Cognito directly (ADR-0006) — none of our Lambdas sit in the sign-in
 * path — and these are unauthenticated JSON calls, so a `fetch` is the whole
 * SDK we need.
 */

export interface CognitoConfig {
  region: string;
  userPoolClientId: string;
}

export interface Tokens {
  accessToken: string;
  /** Absent on a refresh: Cognito keeps the existing one valid. */
  refreshToken?: string;
}

/** Cognito's error, keeping the `__type` the flows branch on. */
export class CognitoError extends Error {
  constructor(
    readonly type: string,
    message: string,
  ) {
    super(message);
    this.name = 'CognitoError';
  }
}

type Fetch = typeof fetch;

export function createCognito(config: CognitoConfig, fetchImpl: Fetch = fetch.bind(globalThis)) {
  const endpoint = `https://cognito-idp.${config.region}.amazonaws.com/`;
  const ClientId = config.userPoolClientId;

  async function call<T>(action: string, body: object): Promise<T> {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-amz-json-1.1',
        'x-amz-target': `AWSCognitoIdentityProviderService.${action}`,
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      // `__type` may be namespaced: `com.amazonaws...#UsernameExistsException`.
      const type = String(json['__type'] ?? 'UnknownError').split('#').pop() ?? 'UnknownError';
      throw new CognitoError(type, String(json['message'] ?? json['Message'] ?? type));
    }
    return json as T;
  }

  interface AuthResult {
    AuthenticationResult?: { AccessToken: string; RefreshToken?: string };
    ChallengeName?: string;
    Session?: string;
  }

  const tokensOf = (result: AuthResult): Tokens => {
    const auth = result.AuthenticationResult;
    if (!auth) throw new CognitoError('UnexpectedChallenge', result.ChallengeName ?? 'no tokens');
    return {
      accessToken: auth.AccessToken,
      ...(auth.RefreshToken ? { refreshToken: auth.RefreshToken } : {}),
    };
  };

  return {
    /** Passwordless sign-up: Cognito emails a confirmation code. */
    async signUp(email: string): Promise<{ session?: string }> {
      const r = await call<{ Session?: string }>('SignUp', {
        ClientId,
        Username: email,
        UserAttributes: [{ Name: 'email', Value: email }],
      });
      return r.Session ? { session: r.Session } : {};
    },

    async resendConfirmationCode(email: string): Promise<void> {
      await call('ResendConfirmationCode', { ClientId, Username: email });
    },

    /**
     * Confirms the code, which fires the post-confirmation trigger, then
     * trades the session it returns for tokens — no second code to type.
     */
    async confirmSignUp(email: string, code: string, session?: string): Promise<Tokens> {
      const confirmed = await call<{ Session?: string }>('ConfirmSignUp', {
        ClientId,
        Username: email,
        ConfirmationCode: code,
        ...(session ? { Session: session } : {}),
      });
      return tokensOf(
        await call<AuthResult>('InitiateAuth', {
          ClientId,
          AuthFlow: 'USER_AUTH',
          AuthParameters: { USERNAME: email },
          ...(confirmed.Session ? { Session: confirmed.Session } : {}),
        }),
      );
    },

    /** Starts an EMAIL_OTP sign-in for an existing user. */
    async startSignIn(email: string): Promise<{ session: string }> {
      const r = await call<AuthResult>('InitiateAuth', {
        ClientId,
        AuthFlow: 'USER_AUTH',
        AuthParameters: { USERNAME: email, PREFERRED_CHALLENGE: 'EMAIL_OTP' },
      });
      if (r.ChallengeName !== 'EMAIL_OTP' || !r.Session) {
        throw new CognitoError('UnexpectedChallenge', r.ChallengeName ?? 'no challenge');
      }
      return { session: r.Session };
    },

    async answerSignIn(email: string, code: string, session: string): Promise<Tokens> {
      return tokensOf(
        await call<AuthResult>('RespondToAuthChallenge', {
          ClientId,
          ChallengeName: 'EMAIL_OTP',
          Session: session,
          ChallengeResponses: { USERNAME: email, EMAIL_OTP_CODE: code },
        }),
      );
    },

    async refresh(refreshToken: string): Promise<Tokens> {
      return tokensOf(
        await call<AuthResult>('InitiateAuth', {
          ClientId,
          AuthFlow: 'REFRESH_TOKEN_AUTH',
          AuthParameters: { REFRESH_TOKEN: refreshToken },
        }),
      );
    },

    async revoke(refreshToken: string): Promise<void> {
      await call('RevokeToken', { ClientId, Token: refreshToken });
    },
  };
}

export type Cognito = ReturnType<typeof createCognito>;

/**
 * Where a submitted email goes next. Sign-up is tried first because its
 * "already exists" answer is reliable, where InitiateAuth's is deliberately
 * not (`preventUserExistenceErrors`).
 */
export type EmailStep =
  | { kind: 'confirm-signup'; email: string; session?: string }
  | { kind: 'sign-in'; email: string; session: string };

export async function submitEmail(cognito: Cognito, rawEmail: string): Promise<EmailStep> {
  const email = rawEmail.trim().toLowerCase();

  try {
    const { session } = await cognito.signUp(email);
    return { kind: 'confirm-signup', email, ...(session ? { session } : {}) };
  } catch (err) {
    if (!(err instanceof CognitoError) || err.type !== 'UsernameExistsException') throw err;
  }

  try {
    const { session } = await cognito.startSignIn(email);
    return { kind: 'sign-in', email, session };
  } catch (err) {
    // Signed up earlier but never entered the code: send a fresh one.
    if (err instanceof CognitoError && err.type === 'UserNotConfirmedException') {
      await cognito.resendConfirmationCode(email);
      return { kind: 'confirm-signup', email };
    }
    throw err;
  }
}
