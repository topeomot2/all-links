import { describe, expect, it } from 'vitest';

import {
  accountKey,
  linkKey,
  otpThrottleKey,
  pageKey,
  usernameIndexKey,
  usernameKey,
} from './index.js';

describe('Account item keys', () => {
  it('puts an Account under its own item collection', () => {
    expect(accountKey('7f3c1e2a-0000-4000-8000-000000000001')).toEqual({
      PK: 'ACCOUNT#7f3c1e2a-0000-4000-8000-000000000001',
      SK: 'ACCOUNT',
    });
  });
});

describe('Page item keys', () => {
  it('shares the Account item collection and sorts first on GSI1', () => {
    expect(pageKey('acct-1', 'jane')).toEqual({
      PK: 'ACCOUNT#acct-1',
      SK: 'PAGE',
      GSI1PK: 'USERNAME#jane',
      GSI1SK: '0',
    });
  });
});

describe('Link item keys', () => {
  it('sorts after the Page on GSI1, in rank order', () => {
    expect(linkKey('acct-1', '01HX4K0000000000000000000A', 'jane', 'a0')).toEqual({
      PK: 'ACCOUNT#acct-1',
      SK: 'LINK#01HX4K0000000000000000000A',
      GSI1PK: 'USERNAME#jane',
      GSI1SK: '1#a0',
    });
  });
});

describe('Username item keys', () => {
  it('is its own single-item partition, so uniqueness is a conditional put', () => {
    expect(usernameKey('jane')).toEqual({
      PK: 'USERNAME#jane',
      SK: 'USERNAME#jane',
    });
  });
});

describe('OTP throttle item keys', () => {
  it('keys by email hash and window, and stays off the public index', () => {
    const hash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

    expect(otpThrottleKey(hash, 'hour')).toEqual({
      PK: `OTP#${hash}`,
      SK: 'WINDOW#hour',
    });
    expect(otpThrottleKey(hash, 'day')).toEqual({
      PK: `OTP#${hash}`,
      SK: 'WINDOW#day',
    });
  });
});

describe('the public read key', () => {
  it('is the same GSI1 partition the Page and its Links are written under', () => {
    const key = usernameIndexKey('jane');

    expect(key).toEqual({ GSI1PK: 'USERNAME#jane' });
    expect(pageKey('acct-1', 'jane').GSI1PK).toBe(key.GSI1PK);
    expect(linkKey('acct-1', 'lnk', 'jane', 'a0').GSI1PK).toBe(key.GSI1PK);
  });
});

describe('username canonicalisation', () => {
  it('lowercases every username-derived key, so case cannot fork an identity', () => {
    expect(usernameKey('JaneDoe').PK).toBe('USERNAME#janedoe');
    expect(pageKey('acct-1', 'JaneDoe').GSI1PK).toBe('USERNAME#janedoe');
    expect(linkKey('acct-1', 'lnk', 'JaneDoe', 'a0').GSI1PK).toBe('USERNAME#janedoe');
    expect(usernameIndexKey('JaneDoe').GSI1PK).toBe('USERNAME#janedoe');
  });
});
