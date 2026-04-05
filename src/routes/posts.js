const express = require('express');
const Post = require('../models/Post');
const Comment = require('../models/Comment');
const Follow = require('../models/Follow');
const User = require('../models/User');
const { authRequired } = require('../middleware/auth');
const { upload } = require('../multerUpload');
const { uploadBuffer } = require('../utils/cloudinary');
const { deleteStoredAsset } = require('../utils/deleteStoredAsset');
const { publicUrl } = require('../utils/publicUrl');
const { toPublicUser } = require('../utils/toPublicUser');

const router = express.Router();

function toPublicPost(req, post, meId, followingSet = null) {
  const o = post.toObject ? post.toObject() : { ...post };
  const id = String(o._id);
  o.id = id;
  delete o._id;
  delete o.__v;
  o.imageUrls = (o.imageUrls || []).map((u) => publicUrl(req, u));
  delete o.imagePublicIds;
  delete o.imageResourceTypes;
  o.likeCount = (o.likeUserIds || []).length;
  o.likedByMe = meId
    ? (o.likeUserIds || []).some((x) => String(x) === String(meId) || String(x?._id) === String(meId))
    : false;
  delete o.likeUserIds;
  if (o.authorId && o.authorId._id) {
    o.author = toPublicUser(req, o.authorId);
    if (followingSet) {
      const aid = String(o.authorId._id);
      o.authorFollowedByMe = followingSet.has(aid);
    }
    delete o.authorId;
  }
  return o;
}

async function commentCountMapForPostIds(postIds) {
  if (!postIds.length) return new Map();
  const rows = await Comment.aggregate([
    {
      $match: {
        postId: { $in: postIds },
        isSuggestion: false,
      },
    },
    {
      $group: {
        _id: '$postId',
        count: { $sum: 1 },
      },
    },
  ]);
  return new Map(rows.map((row) => [String(row._id), Number(row.count || 0)]));
}

router.post('/', authRequired, (req, res, next) => {
  req.uploadType = 'post';
  next();
}, upload.array('images', 6), async (req, res) => {
  try {
    const text = String(req.body.text || '');
    const uploadedImages = await Promise.all(
      (req.files || []).map((file) =>
        uploadBuffer(file, {
          folder: 'posts',
          resourceType: 'image',
        })
      )
    );
    const post = await Post.create({
      authorId: req.userId,
      text,
      imageUrls: uploadedImages.map((asset) => asset.url),
      imagePublicIds: uploadedImages.map((asset) => asset.publicId),
      imageResourceTypes: uploadedImages.map((asset) => asset.resourceType),
      likeUserIds: [],
      sharesCount: 0,
    });
    const populated = await Post.findById(post._id).populate('authorId', 'name username avatarUrl');
    res.status(201).json({ post: toPublicPost(req, populated, req.userId) });
  } catch (e) {
    console.error('[posts.create] upload failed:', e.message);
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.get('/feed', authRequired, async (req, res) => {
  try {
    const following = await Follow.find({ followerId: req.userId }).select('followingId');
    const ids = [...following.map((f) => f.followingId), req.userId];
    const followingSet = new Set(following.map((f) => String(f.followingId)));
    const posts = await Post.find({ authorId: { $in: ids } })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('authorId', 'name username avatarUrl');
    const commentCountMap = await commentCountMapForPostIds(posts.map((post) => post._id));
    res.json({
      posts: posts.map((p) => {
        const post = toPublicPost(req, p, req.userId, followingSet);
        post.commentCount = commentCountMap.get(post.id) || 0;
        return post;
      }),
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.get('/user/:userId', authRequired, async (req, res) => {
  try {
    const posts = await Post.find({ authorId: req.params.userId })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('authorId', 'name username avatarUrl');
    const commentCountMap = await commentCountMapForPostIds(posts.map((post) => post._id));
    res.json({
      posts: posts.map((p) => {
        const post = toPublicPost(req, p, req.userId);
        post.commentCount = commentCountMap.get(post.id) || 0;
        return post;
      }),
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.get('/:id', authRequired, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id).populate('authorId', 'name username avatarUrl');
    if (!post) return res.status(404).json({ error: 'Not found' });
    const publicPost = toPublicPost(req, post, req.userId);
    publicPost.commentCount = await Comment.countDocuments({
      postId: post._id,
      isSuggestion: false,
    });
    res.json({ post: publicPost });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/like', authRequired, async (req, res) => {
  try {
    await Post.updateOne({ _id: req.params.id }, { $addToSet: { likeUserIds: req.userId } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id/like', authRequired, async (req, res) => {
  try {
    await Post.updateOne({ _id: req.params.id }, { $pull: { likeUserIds: req.userId } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/share', authRequired, async (req, res) => {
  try {
    await Post.updateOne({ _id: req.params.id }, { $inc: { sharesCount: 1 } });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/comments', authRequired, async (req, res) => {
  try {
    const comments = await Comment.find({ postId: req.params.id, isSuggestion: false })
      .sort({ createdAt: 1 })
      .populate('authorId', 'name username avatarUrl');
    const suggestions = await Comment.find({ postId: req.params.id, isSuggestion: true })
      .sort({ createdAt: 1 })
      .populate('authorId', 'name username avatarUrl');
    const map = (c) => {
      const o = c.toObject();
      return {
        id: String(o._id),
        text: o.text,
        isSuggestion: o.isSuggestion,
        createdAt: o.createdAt,
        author: toPublicUser(req, o.authorId),
      };
    };
    res.json({
      comments: comments.map(map),
      suggestions: suggestions.map(map),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/comment', authRequired, async (req, res) => {
  try {
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    const c = await Comment.create({
      postId: req.params.id,
      authorId: req.userId,
      text,
      isSuggestion: false,
    });
    const populated = await Comment.findById(c._id).populate('authorId', 'name username avatarUrl');
    const o = populated.toObject();
    res.status(201).json({
      comment: {
        id: String(o._id),
        text: o.text,
        isSuggestion: false,
        createdAt: o.createdAt,
        author: toPublicUser(req, o.authorId),
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/suggest', authRequired, async (req, res) => {
  try {
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    const c = await Comment.create({
      postId: req.params.id,
      authorId: req.userId,
      text,
      isSuggestion: true,
    });
    const populated = await Comment.findById(c._id).populate('authorId', 'name username avatarUrl');
    const o = populated.toObject();
    res.status(201).json({
      suggestion: {
        id: String(o._id),
        text: o.text,
        isSuggestion: true,
        createdAt: o.createdAt,
        author: toPublicUser(req, o.authorId),
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', authRequired, async (req, res) => {
  try {
    const post = await Post.findById(req.params.id);
    if (!post) return res.status(404).json({ error: 'Not found' });
    if (String(post.authorId) !== String(req.userId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    await Comment.deleteMany({ postId: post._id });
    await Post.deleteOne({ _id: post._id });
    await Promise.all(
      (post.imageUrls || []).map((url, index) =>
        deleteStoredAsset({
          url,
          publicId: (post.imagePublicIds || [])[index],
          resourceType: (post.imageResourceTypes || [])[index] || 'image',
        })
      )
    );
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
