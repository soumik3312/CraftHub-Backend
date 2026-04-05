const mongoose = require('mongoose');

const projectSchema = new mongoose.Schema(
  {
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, required: true, trim: true },
    description: { type: String, default: '' },
    githubUrl: { type: String, default: '' },
    genres: [{ type: String }],
    techStack: [{ type: String }],
    /** Public URLs (relative paths resolved with PUBLIC_BASE_URL) */
    imageUrls: [{ type: String }],
    imagePublicIds: [{ type: String }],
    imageResourceTypes: [{ type: String }],
    sourceFile: {
      url: { type: String, default: '' },
      originalName: { type: String, default: '' },
      publicId: { type: String, default: '' },
      resourceType: { type: String, default: 'raw' },
    },
    collaboratorIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    likeUserIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    comments: [
      {
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        text: { type: String, required: true, trim: true },
        createdAt: { type: Date, default: Date.now },
      },
    ],
    workspace: {
      provider: { type: String, default: '' },
      requestedRepoName: { type: String, default: '' },
      repoOwner: { type: String, default: '' },
      repoName: { type: String, default: '' },
      repoFullName: { type: String, default: '' },
      repoUrl: { type: String, default: '' },
      editorUrl: { type: String, default: '' },
      defaultBranch: { type: String, default: 'main' },
      conversationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', default: null },
      createdByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
      createdAt: { type: Date, default: null },
      contributions: [
        {
          userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
          commitCount: { type: Number, default: 0 },
          lastSavedAt: { type: Date, default: null },
          lastFilePath: { type: String, default: '' },
        },
      ],
    },
    /** Random ordering seed for Explore */
    exploreScore: { type: Number, default: () => Math.random() },
  },
  { timestamps: true }
);

projectSchema.index({ ownerId: 1 });
projectSchema.index({ genres: 1 });
projectSchema.index({ title: 'text', description: 'text' });
projectSchema.index({ exploreScore: 1, _id: 1 });

module.exports = mongoose.model('Project', projectSchema);
