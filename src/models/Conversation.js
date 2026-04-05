const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['dm', 'group'], required: true },
    name: { type: String, default: '' },
    participantIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }],
    memberState: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        lastReadAt: { type: Date, default: Date.now },
      },
    ],
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null },
    lastMessageAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

conversationSchema.index({ participantIds: 1 });
conversationSchema.index({ lastMessageAt: -1 });

module.exports = mongoose.model('Conversation', conversationSchema);
