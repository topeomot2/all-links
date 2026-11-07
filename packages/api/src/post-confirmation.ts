import { createDynamoAccountStore, type AccountStore } from '@all-links/core';
import type { PostConfirmationTriggerEvent } from 'aws-lambda';

/**
 * Cognito post-confirmation trigger: the moment an email is verified, an
 * Account exists (ADR-0005). `accountId` is the Cognito `sub`; the Account
 * starts inactive with no Subscription — checkout comes after the claim.
 *
 * Cognito retries a trigger that throws, and the write is conditional, so a
 * retry after a partial failure is safe. The event must be returned as-is.
 */
export function createPostConfirmation(accounts: () => AccountStore) {
  return async (event: PostConfirmationTriggerEvent): Promise<PostConfirmationTriggerEvent> => {
    // Also fires after a forgotten-password reset, which this pool has no
    // use for; only a sign-up confirmation creates an Account.
    if (event.triggerSource !== 'PostConfirmation_ConfirmSignUp') return event;

    const { sub, email } = event.request.userAttributes;
    if (!sub || !email) throw new Error('post-confirmation event is missing sub or email');

    await accounts().createAccount({ accountId: sub, email: email.toLowerCase() });

    return event;
  };
}

let store: AccountStore | undefined;

export const handler = createPostConfirmation(() => {
  const tableName = process.env['TABLE_NAME'];
  if (!tableName) throw new Error('TABLE_NAME is not set');
  store ??= createDynamoAccountStore(tableName);

  return store;
});
