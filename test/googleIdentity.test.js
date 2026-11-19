const assert = require('node:assert/strict');
const test = require('node:test');

const {
  configuredGoogleClientIds,
  createPendingRegistrationToken,
  hashPendingRegistrationToken,
  pendingRegistrationExpiry,
  validateGooglePayload,
} = require('../src/utils/googleIdentity');

test('uses only configured non-empty Google audiences', () => {
  assert.deepEqual(
    configuredGoogleClientIds({
      GOOGLE_WEB_CLIENT_ID: ' web.apps.googleusercontent.com, , second.apps.googleusercontent.com ',
    }),
    ['web.apps.googleusercontent.com', 'second.apps.googleusercontent.com']
  );
});

test('accepts a verified Google identity from an allowed issuer', () => {
  assert.deepEqual(
    validateGooglePayload({
      iss: 'https://accounts.google.com',
      sub: '1133557799',
      email: 'User@Example.com',
      email_verified: true,
      name: 'Craft User',
    }),
    {
      subject: '1133557799',
      email: 'user@example.com',
      name: 'Craft User',
    }
  );
});

test('rejects an unverified email and a non-Google issuer', () => {
  assert.throws(
    () =>
      validateGooglePayload({
        iss: 'https://accounts.google.com',
        sub: '123',
        email: 'user@example.com',
        email_verified: false,
      }),
    { code: 'GOOGLE_EMAIL_NOT_VERIFIED' }
  );
  assert.throws(
    () =>
      validateGooglePayload({
        iss: 'https://issuer.example',
        sub: '123',
        email: 'user@example.com',
        email_verified: true,
      }),
    { code: 'INVALID_GOOGLE_TOKEN' }
  );
});

test('pending registration tokens are random, hashed, and short lived', () => {
  const first = createPendingRegistrationToken();
  const second = createPendingRegistrationToken();
  assert.notEqual(first, second);
  assert.equal(hashPendingRegistrationToken(first).length, 64);
  assert.notEqual(hashPendingRegistrationToken(first), first);

  const now = Date.UTC(2026, 10, 20, 0, 0, 0);
  assert.equal(
    pendingRegistrationExpiry({ GOOGLE_PENDING_REGISTRATION_TTL_MINUTES: '500' }, now).getTime(),
    now + 30 * 60 * 1000
  );
  assert.equal(
    pendingRegistrationExpiry({ GOOGLE_PENDING_REGISTRATION_TTL_MINUTES: '1' }, now).getTime(),
    now + 5 * 60 * 1000
  );
});
