const mongoose = require('mongoose');
const { DEFAULT_USER_SETTINGS, NOTIFICATION_DEFAULTS } = require('../utils/userSettings');

const userSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    /** false until email OTP verified; existing DB docs without this field are treated as verified on read in auth flows */
    emailVerified: { type: Boolean, default: false },
    passwordHash: { type: String, required: true },
    name: { type: String, required: true, trim: true },
    username: { type: String, required: true, unique: true, lowercase: true, trim: true },
    bio: { type: String, default: '' },
    avatarUrl: { type: String, default: '' },
    avatarPublicId: { type: String, default: '' },
    avatarResourceType: { type: String, default: 'image' },
    /** Topics the user cares about (matchmaking + discovery) */
    genres: [{ type: String }],
    /** Accepted collaboration partners */
    networkPartnerIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    /** Connected GitHub account used for collaboration workspaces */
    githubConnected: { type: Boolean, default: false },
    githubId: { type: String, default: '' },
    githubUsername: { type: String, default: '' },
    githubProfileUrl: { type: String, default: '' },
    githubAccessToken: { type: String, default: '' },
    settings: {
      themeMode: {
        type: String,
        enum: ['system', 'light', 'dark'],
        default: DEFAULT_USER_SETTINGS.themeMode,
      },
      notifications: {
        enabled: { type: Boolean, default: NOTIFICATION_DEFAULTS.enabled },
        directMessages: {
          type: Boolean,
          default: NOTIFICATION_DEFAULTS.directMessages,
        },
        workspaceMessages: {
          type: Boolean,
          default: NOTIFICATION_DEFAULTS.workspaceMessages,
        },
      },
    },
  },
  { timestamps: true }
);

userSchema.index({ username: 1 });
userSchema.index({ name: 'text', username: 'text', bio: 'text' });

module.exports = mongoose.model('User', userSchema);
