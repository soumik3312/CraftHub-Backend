const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const OtpToken = require('../models/OtpToken');
const PendingGoogleRegistration = require('../models/PendingGoogleRegistration');
const { toPublicUser } = require('../utils/toPublicUser');
const { uploadBuffer } = require('../utils/cloudinary');
const { deleteStoredAsset } = require('../utils/deleteStoredAsset');
const { sendMail } = require('../utils/mailer');
const { generateOtpCode, hashOtp, otpCodesMatch, otpExpiryDate } = require('../utils/otpCore');
const {
  createPendingRegistrationToken,
  hashPendingRegistrationToken,
  pendingRegistrationExpiry,
  verifyGoogleIdToken,
} = require('../utils/googleIdentity');

function signToken(userId) {
  return jwt.sign({ sub: String(userId) }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

function isEmailVerified(user) {
  if (!user) return false;
  // Accounts that existed before OTP did not store this field. Mongoose applies
  // the schema default (`false`) while hydrating them, so identify that default
  // value explicitly and preserve access for those established accounts.
  return user.emailVerified === true || user.$isDefault?.('emailVerified') === true;
}

function normalizeGenres(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  return source.map((genre) => String(genre).trim()).filter(Boolean);
}

function isDuplicateKeyError(error) {
  return error && (error.code === 11000 || error.name === 'MongoServerError' && error.code === 11000);
}

function duplicateKeyName(error) {
  return Object.keys(error?.keyPattern || error?.keyValue || {})[0] || '';
}

async function googleIdentityFromRequest(req, res) {
  try {
    return await verifyGoogleIdToken(req.body?.idToken);
  } catch (error) {
    res.status(error.status || 401).json({
      error: error.message || 'Google authentication failed.',
      code: error.code || 'INVALID_GOOGLE_TOKEN',
    });
    return null;
  }
}

async function persistOtp(email, purpose, plainCode) {
  await OtpToken.deleteMany({ email, purpose });
  await OtpToken.create({
    email,
    purpose,
    codeHash: hashOtp(plainCode),
    expiresAt: otpExpiryDate(),
    attempts: 0,
  });
}

function registerEmailBody(plainCode) {
  const mins = Math.max(5, Math.min(60, Number(process.env.OTP_EXPIRY_MINUTES || 15)));
  return {
    subject: 'Craft Hub - verify your email',
    text: `Your verification code is: ${plainCode}\n\nIt expires in ${mins} minutes. If you did not sign up, ignore this email.`,
  };
}

exports.register = async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const password = req.body.password || '';
  const name = (req.body.name || '').trim();
  const username = (req.body.username || '').toLowerCase().trim().replace(/\s+/g, '_');
  if (!email || !password || !name || !username) {
    return res.status(400).json({ error: 'email, password, name, username required' });
  }

  let user = await User.findOne({ email });

  if (user && isEmailVerified(user)) {
    return res.status(409).json({ error: 'Email already registered' });
  }

  const usernameOwner = await User.findOne({ username });
  if (usernameOwner && (!user || String(usernameOwner._id) !== String(user._id))) {
    return res.status(409).json({ error: 'Username already taken' });
  }

  const passwordHash = await bcrypt.hash(password, 10);
  let avatarAsset = null;
  if (req.file) {
    avatarAsset = await uploadBuffer(req.file, {
      folder: 'avatars',
      resourceType: 'image',
    });
  }
  const avatarUrl = avatarAsset?.url || '';
  const genres = req.body.genres
    ? String(req.body.genres)
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean)
    : [];
  const bio = (req.body.bio || '').trim();

  if (user && !isEmailVerified(user)) {
    const previousAvatar = {
      url: user.avatarUrl,
      publicId: user.avatarPublicId,
      resourceType: user.avatarResourceType,
    };
    user.passwordHash = passwordHash;
    user.name = name;
    user.username = username;
    user.bio = bio;
    user.genres = genres;
    if (avatarAsset) {
      user.avatarUrl = avatarAsset.url;
      user.avatarPublicId = avatarAsset.publicId;
      user.avatarResourceType = avatarAsset.resourceType;
    }
    user.emailVerified = false;
    await user.save();
    if (avatarAsset && previousAvatar.url && previousAvatar.url !== user.avatarUrl) {
      await deleteStoredAsset(previousAvatar);
    }
  } else {
    user = await User.create({
      email,
      emailVerified: false,
      passwordHash,
      name,
      username,
      bio,
      avatarUrl,
      avatarPublicId: avatarAsset?.publicId || '',
      avatarResourceType: avatarAsset?.resourceType || 'image',
      genres,
    });
  }

  const plain = generateOtpCode();
  const regBody = registerEmailBody(plain);
  try {
    await sendMail({ to: email, subject: regBody.subject, text: regBody.text });
    await persistOtp(email, 'register', plain);
    res.status(201).json({
      needOtp: true,
      purpose: 'register',
      email,
      message: 'We sent a verification code to your email.',
    });
  } catch (error) {
    console.error('[Craft Hub mail] Registration OTP delivery failed:', error.message);
    res.status(502).json({
      error: 'We could not send the verification email. Please try again later.',
    });
  }
};

exports.verifyRegister = async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const code = String(req.body.code || '').trim();
  if (!email || !code) return res.status(400).json({ error: 'email and code required' });

  const user = await User.findOne({ email });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (isEmailVerified(user)) return res.status(400).json({ error: 'Email already verified - try logging in' });

  const otp = await OtpToken.findOne({ email, purpose: 'register' });
  if (!otp) return res.status(400).json({ error: 'No active code - request a new one' });
  if (otp.expiresAt.getTime() < Date.now()) {
    await OtpToken.deleteOne({ _id: otp._id });
    return res.status(400).json({ error: 'Code expired - request a new one' });
  }

  if (otp.attempts >= 8) {
    await OtpToken.deleteOne({ _id: otp._id });
    return res.status(429).json({ error: 'Too many attempts - request a new code' });
  }

  otp.attempts += 1;
  await otp.save();

  if (!otpCodesMatch(code, otp.codeHash)) {
    return res.status(401).json({ error: 'Invalid code' });
  }

  await OtpToken.deleteMany({ email, purpose: 'register' });
  user.emailVerified = true;
  await user.save();

  const token = signToken(user._id);
  res.json({ token, user: toPublicUser(req, user) });
};

exports.resendRegister = async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  if (!email) return res.status(400).json({ error: 'email required' });
  const user = await User.findOne({ email });
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (isEmailVerified(user)) return res.status(400).json({ error: 'Already verified' });

  const plain = generateOtpCode();
  const body = registerEmailBody(plain);
  try {
    await sendMail({ to: email, subject: body.subject, text: body.text });
    await persistOtp(email, 'register', plain);
    res.json({ ok: true, message: 'New code sent' });
  } catch (error) {
    console.error('[Craft Hub mail] Registration OTP resend failed:', error.message);
    res.status(502).json({
      error: 'We could not send the verification email. Please try again later.',
    });
  }
};

exports.login = async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim();
  const password = req.body.password || '';
  const user = await User.findOne({ email });
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  if (!isEmailVerified(user)) {
    return res.status(403).json({
      error: 'Please verify your email first.',
      code: 'EMAIL_NOT_VERIFIED',
      email: user.email,
    });
  }

  if (user.$isDefault?.('emailVerified') === true || user.emailVerified === undefined) {
    user.emailVerified = true;
    await user.save();
  }
  await OtpToken.deleteMany({ email, purpose: 'login' });
  const token = signToken(user._id);
  res.json({ token, user: toPublicUser(req, user) });
};

exports.verifyLogin = async (req, res) => {
  res.status(410).json({ error: 'Login OTP is disabled. Sign in again with email and password.' });
};

exports.resendLogin = async (req, res) => {
  res.status(410).json({ error: 'Login OTP is disabled. Sign in again with email and password.' });
};

/**
 * Verifies a Google identity and hands the client a short-lived opaque token
 * for completing the normal Craft Hub registration form. No User is created
 * here and no Brevo/OTP function is called.
 */
exports.googleRegister = async (req, res) => {
  const identity = await googleIdentityFromRequest(req, res);
  if (!identity) return;

  const linkedUser = await User.findOne({ googleSubject: identity.subject });
  if (linkedUser) {
    return res.status(409).json({
      error: 'This Google account is already registered. Use Continue with Google on the sign-in screen.',
      code: 'GOOGLE_ACCOUNT_ALREADY_REGISTERED',
    });
  }

  const emailUser = await User.findOne({ email: identity.email });
  if (emailUser) {
    const code = isEmailVerified(emailUser)
      ? 'EMAIL_ACCOUNT_ALREADY_EXISTS'
      : 'EXISTING_EMAIL_NOT_VERIFIED';
    const error = isEmailVerified(emailUser)
      ? 'An account with this verified email already exists. Use Continue with Google on the sign-in screen to link it securely.'
      : 'An existing account with this email still needs email verification. Finish that verification or use account recovery first.';
    return res.status(409).json({ error, code });
  }

  // A fresh Google selection supersedes abandoned registration sessions for
  // that identity. Tokens are still one-time and are stored only as hashes.
  await PendingGoogleRegistration.deleteMany({
    googleSubject: identity.subject,
    usedAt: null,
  });
  const registrationToken = createPendingRegistrationToken();
  const expiresAt = pendingRegistrationExpiry();
  await PendingGoogleRegistration.create({
    tokenHash: hashPendingRegistrationToken(registrationToken),
    googleSubject: identity.subject,
    email: identity.email,
    name: identity.name,
    expiresAt,
  });

  return res.status(201).json({
    registrationToken,
    profile: { name: identity.name, email: identity.email },
    expiresAt: expiresAt.toISOString(),
  });
};

/**
 * Finishes a Google registration only after the existing form fields have
 * been supplied. The pending token is atomically consumed before user
 * creation, preventing concurrent/replayed submissions from creating twins.
 */
exports.completeGoogleRegistration = async (req, res) => {
  const registrationToken = String(req.body?.registrationToken || '').trim();
  const password = req.body?.password || '';
  const name = String(req.body?.name || '').trim();
  const username = String(req.body?.username || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '_');
  const bio = String(req.body?.bio || '').trim();
  const genres = normalizeGenres(req.body?.genres);

  if (!registrationToken || !password || !name || !username) {
    return res.status(400).json({
      error: 'registrationToken, password, name, and username are required.',
      code: 'GOOGLE_REGISTRATION_FIELDS_REQUIRED',
    });
  }

  const usernameOwner = await User.findOne({ username });
  if (usernameOwner) {
    return res.status(409).json({ error: 'Username already taken', code: 'USERNAME_TAKEN' });
  }

  const usedAt = new Date();
  const pending = await PendingGoogleRegistration.findOneAndUpdate(
    {
      tokenHash: hashPendingRegistrationToken(registrationToken),
      usedAt: null,
      expiresAt: { $gt: usedAt },
    },
    { $set: { usedAt } },
    { new: true }
  );
  if (!pending) {
    return res.status(400).json({
      error: 'This Google registration session expired or was already used. Continue with Google again.',
      code: 'GOOGLE_REGISTRATION_TOKEN_INVALID',
    });
  }

  // Check again after atomically claiming the hand-off; unique indexes below
  // remain the final guard against races from another request or process.
  const existing = await User.findOne({
    $or: [{ email: pending.email }, { googleSubject: pending.googleSubject }],
  });
  if (existing) {
    return res.status(409).json({
      error: 'An account for this Google identity or email already exists. Use Continue with Google on the sign-in screen.',
      code: 'GOOGLE_ACCOUNT_CONFLICT',
    });
  }

  try {
    const user = await User.create({
      email: pending.email,
      // The email claim was verified by Google server-side; OTP is deliberately
      // not created or sent for this distinct registration method.
      emailVerified: true,
      googleSubject: pending.googleSubject,
      passwordHash: await bcrypt.hash(password, 10),
      name,
      username,
      bio,
      genres,
    });
    const token = signToken(user._id);
    return res.status(201).json({ token, user: toPublicUser(req, user) });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const key = duplicateKeyName(error);
      const message = key === 'username'
        ? 'Username already taken'
        : 'An account for this Google identity or email already exists. Use Continue with Google on the sign-in screen.';
      return res.status(409).json({ error: message, code: 'GOOGLE_ACCOUNT_CONFLICT' });
    }
    throw error;
  }
};

/**
 * Signs in a linked Google user. A pre-existing email/password user is linked
 * only when Google verifies that same, already-verified email. No profile,
 * password, user ID, or associated records are changed.
 */
exports.googleLogin = async (req, res) => {
  const identity = await googleIdentityFromRequest(req, res);
  if (!identity) return;

  let user = await User.findOne({ googleSubject: identity.subject });
  if (user) {
    if (user.email !== identity.email) {
      return res.status(409).json({
        error: 'This Google identity is linked to an account with a different email. Contact support to resolve the conflict.',
        code: 'GOOGLE_EMAIL_CONFLICT',
      });
    }
    if (!isEmailVerified(user)) {
      return res.status(403).json({
        error: 'This Craft Hub account still needs email verification. Complete the existing verification flow first.',
        code: 'EMAIL_NOT_VERIFIED',
      });
    }
    return res.json({ token: signToken(user._id), user: toPublicUser(req, user) });
  }

  user = await User.findOne({ email: identity.email });
  if (!user) {
    return res.status(404).json({
      error: 'No Craft Hub account exists for this Google account. Create an account first.',
      code: 'GOOGLE_REGISTRATION_REQUIRED',
    });
  }
  if (!isEmailVerified(user)) {
    return res.status(403).json({
      error: 'This Craft Hub account still needs email verification. Complete the existing verification flow first.',
      code: 'EMAIL_NOT_VERIFIED',
    });
  }
  if (user.googleSubject && user.googleSubject !== identity.subject) {
    return res.status(409).json({
      error: 'This Craft Hub account is already linked to a different Google account.',
      code: 'GOOGLE_IDENTITY_CONFLICT',
    });
  }

  try {
    const linkedUser = await User.findOneAndUpdate(
      {
        _id: user._id,
        $or: [
          { googleSubject: { $exists: false } },
          { googleSubject: null },
          { googleSubject: '' },
          { googleSubject: identity.subject },
        ],
      },
      { $set: { googleSubject: identity.subject } },
      { new: true }
    );
    if (!linkedUser) {
      return res.status(409).json({
        error: 'This Craft Hub account could not be linked to that Google account securely.',
        code: 'GOOGLE_IDENTITY_CONFLICT',
      });
    }
    return res.json({ token: signToken(linkedUser._id), user: toPublicUser(req, linkedUser) });
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      return res.status(409).json({
        error: 'That Google account is already linked to another Craft Hub account.',
        code: 'GOOGLE_IDENTITY_CONFLICT',
      });
    }
    throw error;
  }
};

exports.me = async (req, res) => {
  const user = await User.findById(req.userId).select('-passwordHash');
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ user: toPublicUser(req, user) });
};
