const crypto = require('crypto');

function otpPepper() {
  return process.env.OTP_PEPPER || process.env.JWT_SECRET || 'change-me';
}

/** Cryptographically random 6-digit code (000000–999999), uniform distribution. */
function generateOtpCode() {
  const n = crypto.randomInt(0, 1_000_000);
  return String(n).padStart(6, '0');
}

function hashOtp(code) {
  return crypto.createHmac('sha256', otpPepper()).update(String(code).trim()).digest('hex');
}

function otpCodesMatch(plainCode, storedHash) {
  try {
    const a = Buffer.from(hashOtp(plainCode), 'hex');
    const b = Buffer.from(String(storedHash).trim(), 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function otpExpiryDate() {
  const mins = Math.max(5, Math.min(60, Number(process.env.OTP_EXPIRY_MINUTES || 15)));
  return new Date(Date.now() + mins * 60 * 1000);
}

module.exports = { generateOtpCode, hashOtp, otpCodesMatch, otpExpiryDate };
