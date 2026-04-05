const mongoose = require('mongoose');

const collabRequestSchema = new mongoose.Schema(
  {
    fromUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    toUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    projectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Project', default: null },
    /** project_invite | project_request | network(legacy) */
    type: { type: String, enum: ['project_invite', 'project_request', 'network'], required: true },
    message: { type: String, default: '' },
    status: { type: String, enum: ['pending', 'accepted', 'connected', 'rejected'], default: 'pending' },
  },
  { timestamps: true }
);

collabRequestSchema.index({ toUserId: 1, status: 1 });
collabRequestSchema.index({ fromUserId: 1, toUserId: 1, projectId: 1, type: 1 });

module.exports = mongoose.model('CollabRequest', collabRequestSchema);
