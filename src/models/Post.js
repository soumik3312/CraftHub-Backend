const mongoose = require('mongoose');

const postSchema = new mongoose.Schema(
  {
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, default: '' },
    imageUrls: [{ type: String }],
    imagePublicIds: [{ type: String }],
    imageResourceTypes: [{ type: String }],
    likeUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    sharesCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

postSchema.index({ authorId: 1, createdAt: -1 });
postSchema.index({ createdAt: -1 });

module.exports = mongoose.model('Post', postSchema);
