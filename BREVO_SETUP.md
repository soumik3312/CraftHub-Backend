# Brevo Setup For Craft Hub

This app now sends registration OTP emails through Brevo's transactional email API instead of SMTP.

## What changed in the backend

- `src/utils/mailer.js`
  Uses Brevo's transactional email API (`/v3/smtp/email`) with `fetch`.
- `src/index.js`
  Logs whether Brevo is configured when the server starts.
- `src/controllers/authController.js`
  Registration OTP still works the same, but delivery is now through Brevo.

Login OTP is already disabled. Only registration sends OTP.

## Brevo account setup

1. Create a Brevo account.
2. Verify your email address inside Brevo.
3. Add a sender email in Brevo.
4. Verify that sender email.
5. Create an API key in Brevo.

Important:
- The sender email in `BREVO_FROM_EMAIL` must match a sender you verified in Brevo.
- For better delivery, set up your domain authentication in Brevo later, but a verified sender is enough to start.

## Local `.env` values

Add these to your backend `.env`:

```env
BREVO_API_KEY=your_brevo_api_key
BREVO_FROM_EMAIL=your_verified_sender@example.com
BREVO_FROM_NAME=Craft Hub
BREVO_REQUIRED=1
BREVO_TIMEOUT_MS=20000
```

Notes:
- `BREVO_REQUIRED=1` means the server will fail OTP sending if Brevo is not configured correctly.
- If you temporarily set `BREVO_REQUIRED=0`, OTP will be printed to the backend console instead.

## Render environment variables

In your Render backend service:

1. Open your service dashboard.
2. Go to `Environment`.
3. Add:
   - `BREVO_API_KEY`
   - `BREVO_FROM_EMAIL`
   - `BREVO_FROM_NAME`
   - `BREVO_REQUIRED`
   - `BREVO_TIMEOUT_MS`
4. Save changes.
5. Redeploy the service.

Recommended values:

```env
BREVO_FROM_NAME=Craft Hub
BREVO_REQUIRED=1
BREVO_TIMEOUT_MS=20000
```

## How to test

1. Start or redeploy the backend.
2. Watch backend logs.
3. Register a brand new account in the app.
4. Check the email inbox of that new account.
5. Enter the OTP in the app.

Expected result:
- New registration sends OTP email.
- Login does not send OTP.

## Troubleshooting

If OTP is not arriving:

1. Check backend logs for Brevo errors.
2. Confirm `BREVO_API_KEY` is correct.
3. Confirm `BREVO_FROM_EMAIL` is a verified sender in Brevo.
4. Check spam/junk folder.
5. If Brevo rejects the sender, verify the sender again in the Brevo dashboard.
