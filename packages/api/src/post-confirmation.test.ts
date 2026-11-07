import type { AccountStore } from '@all-links/core';
import type { PostConfirmationTriggerEvent } from 'aws-lambda';
import { describe, expect, it } from 'vitest';

import { createPostConfirmation } from './post-confirmation.js';

function event(
  triggerSource: PostConfirmationTriggerEvent['triggerSource'],
  userAttributes: Record<string, string> = { sub: 'sub-1', email: 'Jane@Example.com' },
): PostConfirmationTriggerEvent {
  return {
    version: '1',
    region: 'us-east-1',
    userPoolId: 'pool',
    userName: 'sub-1',
    callerContext: { awsSdkVersion: '1', clientId: 'client' },
    triggerSource,
    request: { userAttributes },
    response: {},
  };
}

function storeSpy() {
  const created: { accountId: string; email: string }[] = [];
  const store: AccountStore = {
    loadAccount: () => Promise.resolve(undefined),
    createAccount: (input) => {
      created.push(input);
      return Promise.resolve();
    },
  };
  return { created, trigger: createPostConfirmation(() => store) };
}

describe('the post-confirmation trigger', () => {
  it('creates the Account keyed by the Cognito sub, email lowercased', async () => {
    const { created, trigger } = storeSpy();
    await trigger(event('PostConfirmation_ConfirmSignUp'));

    expect(created).toEqual([{ accountId: 'sub-1', email: 'jane@example.com' }]);
  });

  it('returns the event unchanged, as Cognito requires', async () => {
    const { trigger } = storeSpy();
    const e = event('PostConfirmation_ConfirmSignUp');

    expect(await trigger(e)).toBe(e);
  });

  it('does nothing after a forgotten-password confirmation', async () => {
    const { created, trigger } = storeSpy();
    await trigger(event('PostConfirmation_ConfirmForgotPassword'));

    expect(created).toEqual([]);
  });

  it('fails loudly rather than write an Account with no identity', async () => {
    const { trigger } = storeSpy();

    await expect(
      trigger(event('PostConfirmation_ConfirmSignUp', { email: 'a@b.c' })),
    ).rejects.toThrow();
  });
});
