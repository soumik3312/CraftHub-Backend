const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const OtpToken = require('../models/OtpToken');
const { toPublicUser } = require('../utils/toPublicUser');
const { uploadBuffer } = require('../utils/cloudinary');
const { deleteStoredAsset } = require('../utils/deleteStoredAsset');
const { sendMail } = require('../utils/mailer');
const { generateOtpCode, hashOtp, otpCodesMatch, otpExpiryDate } = require('../utils/otpCore');

// Never block the HTTP response on email delivery. If Brevo is misconfigured, log it loudly.
function queueOtpEmail(sendFn) {
  setImmediate(() => {
    sendFn().catch((err) => {
      console.error('[Craft Hub mail] OTP email FAILED:', err.message);
      console.error('[Craft Hub mail] Fix .env / Render vars: BREVO_API_KEY, BREVO_FROM_EMAIL, BREVO_FROM_NAME');
    });
  });
}

function signToken(userId) {
  return jwt.sign({ sub: String(userId) }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

function isEmailVerified(user) {
  if (!user) return false;
  return user.emailVerified === true;
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
  await persistOtp(email, 'register', plain);

  res.status(201).json({
    needOtp: true,
    purpose: 'register',
    email,
    message: 'We sent a verification code to your email.',
  });

  const regBody = registerEmailBody(plain);
  queueOtpEmail(() => sendMail({ to: email, subject: regBody.subject, text: regBody.text }));
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
  await persistOtp(email, 'register', plain);

  res.json({ ok: true, message: 'New code sent' });

  const body = registerEmailBody(plain);
  queueOtpEmail(() => sendMail({ to: email, subject: body.subject, text: body.text }));
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

exports.me = async (req, res) => {
  const user = await User.findById(req.userId).select('-passwordHash');
  if (!user) return res.status(404).json({ error: 'Not found' });
  res.json({ user: toPublicUser(req, user) });
};
