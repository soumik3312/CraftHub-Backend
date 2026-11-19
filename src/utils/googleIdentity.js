const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');

const GOOGLE_ISSUERS = new Set([
  'accounts.google.com',
  'https://accounts.google.com',
]);

function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function configuredGoogleClientIds(env = process.env) {
  return String(env.GOOGLE_WEB_CLIENT_ID || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

function validateGooglePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw httpError(401, 'INVALID_GOOGLE_TOKEN', 'Google returned an invalid identity token.');
  }
  if (!GOOGLE_ISSUERS.has(payload.iss)) {
    throw httpError(401, 'INVALID_GOOGLE_TOKEN', 'Google identity token issuer is not allowed.');
  }
  if (payload.email_verified !== true) {
    throw httpError(
      401,
      'GOOGLE_EMAIL_NOT_VERIFIED',
      'Your Google account email must be verified before you can sign in.'
    );
  }

  const subject = String(payload.sub || '').trim();
  const email = String(payload.email || '').toLowerCase().trim();
  if (!subject || !email) {
    throw httpError(401, 'INVALID_GOOGLE_TOKEN', 'Google identity token is missing a subject or email.');
  }

  return {
    subject,
    email,
    name: String(payload.name || '').trim(),
  };
}

async function verifyGoogleIdToken(idToken, { client = new OAuth2Client(), env = process.env } = {}) {
  if (typeof idToken !== 'string' || !idToken.trim()) {
    throw httpError(400, 'GOOGLE_ID_TOKEN_REQUIRED', 'Google ID token is required.');
  }

  const audience = configuredGoogleClientIds(env);
  if (!audience.length) {
    throw httpError(
      503,
      'GOOGLE_AUTH_NOT_CONFIGURED',
      'Google sign-in is not configured on this server yet.'
    );
  }

  try {
    const ticket = await client.verifyIdToken({
      idToken: idToken.trim(),
      audience,
    });
    return validateGooglePayload(ticket.getPayload());
  } catch (error) {
    if (error.status) throw error;
    throw httpError(401, 'INVALID_GOOGLE_TOKEN', 'Google identity token could not be verified.');
  }
}

function createPendingRegistrationToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashPendingRegistrationToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function pendingRegistrationExpiry(env = process.env, now = Date.now()) {
  const minutes = Math.max(
    5,
    Math.min(30, Number(env.GOOGLE_PENDING_REGISTRATION_TTL_MINUTES || 15))
  );
  return new Date(now + minutes * 60 * 1000);
}

module.exports = {
  configuredGoogleClientIds,
  createPendingRegistrationToken,
  hashPendingRegistrationToken,
  httpError,
  pendingRegistrationExpiry,
  validateGooglePayload,
  verifyGoogleIdToken,
};
