const mongoose = require('mongoose');

/**
 * An opaque, short-lived hand-off between Google identity verification and the
 * existing Craft Hub profile form. This is deliberately not a JWT or a Craft
 * Hub session: possession only permits one attempted account completion.
 */
const pendingGoogleRegistrationSchema = new mongoose.Schema(
  {
    // SHA-256 of the browser/app token. The raw token is returned once only.
    tokenHash: { type: String, required: true, unique: true },
    googleSubject: { type: String, required: true, trim: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    name: { type: String, default: '', trim: true },
    expiresAt: { type: Date, required: true },
    // Atomically set when completion starts, so a token cannot be replayed.
    usedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

pendingGoogleRegistrationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model(
  'PendingGoogleRegistration',
  pendingGoogleRegistrationSchema
);
