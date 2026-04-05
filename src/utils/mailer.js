const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

function isPlaceholder(value) {
  const normalized = String(value || '').trim();
  if (!normalized) return true;
  return /^your_/i.test(normalized) || normalized.includes('example.com');
}

function hasBrevoConfig() {
  return !isPlaceholder(process.env.BREVO_API_KEY) && !isPlaceholder(process.env.BREVO_FROM_EMAIL);
}

function resolveSender() {
  return {
    name: (process.env.BREVO_FROM_NAME || 'Craft Hub').trim(),
    email: String(process.env.BREVO_FROM_EMAIL || '').trim().toLowerCase(),
  };
}

function timeouts() {
  return {
    signal: AbortSignal.timeout(Number(process.env.BREVO_TIMEOUT_MS || 20000)),
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function logConsoleOtp({ to, subject, text }) {
  console.log('\n========== Craft Hub OTP (no Brevo) ==========');
  console.log(`To: ${to}`);
  console.log(`Subject: ${subject}`);
  console.log(text);
  console.log('=============================================\n');
}

async function sendBrevoEmail({ to, subject, text }) {
  const sender = resolveSender();
  const response = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'api-key': String(process.env.BREVO_API_KEY || '').trim(),
    },
    body: JSON.stringify({
      sender,
      to: [{ email: String(to).trim().toLowerCase() }],
      subject,
      textContent: text,
      htmlContent: `<p>${escapeHtml(text).replace(/\n/g, '<br/>')}</p>`,
    }),
    ...timeouts(),
  });

  if (!response.ok) {
    let details = '';
    try {
      const data = await response.json();
      details = data.message || data.code || JSON.stringify(data);
    } catch {
      details = await response.text();
    }
    const error = new Error(`Brevo email send failed (${response.status}): ${details || 'Unknown error'}`);
    error.status = 502;
    throw error;
  }

  return response.json().catch(() => ({}));
}

// Sends one email. If Brevo is not configured, prints OTP to console as a dev fallback.
async function sendMail({ to, subject, text }) {
  if (!hasBrevoConfig()) {
    const must = process.env.BREVO_REQUIRED === '1';
    logConsoleOtp({ to, subject, text });
    if (must) {
      throw new Error('Brevo is not configured correctly. Set BREVO_API_KEY, BREVO_FROM_EMAIL, and BREVO_FROM_NAME.');
    }
    return;
  }

  await sendBrevoEmail({ to, subject, text });
}

// Call once after server starts to log whether real transactional email is configured.
async function verifyEmailProviderIfConfigured() {
  if (!hasBrevoConfig()) {
    console.log('[email] Brevo not active (missing credentials). OTPs are printed in this console.');
    return;
  }

  const sender = resolveSender();
  console.log(`[email] Brevo configured for transactional email using sender ${sender.email}.`);
}

module.exports = { sendMail, verifyEmailProviderIfConfigured };
