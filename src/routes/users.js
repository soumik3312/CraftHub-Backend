const express = require('express');
const User = require('../models/User');
const Follow = require('../models/Follow');
const Project = require('../models/Project');
const { authRequired } = require('../middleware/auth');
const { upload } = require('../multerUpload');
const { toPublicUser } = require('../utils/toPublicUser');
const { uploadBuffer } = require('../utils/cloudinary');
const { deleteStoredAsset } = require('../utils/deleteStoredAsset');
const { PROJECT_GENRES } = require('../constants');
const { normalizeThemeMode, normalizeUserSettings } = require('../utils/userSettings');

const router = express.Router();

async function collabPartnersFromProjects(userId) {
  const uid = String(userId);
  const projects = await Project.find({
    $or: [{ ownerId: userId }, { collaboratorIds: userId }],
  }).select('ownerId collaboratorIds');

  const ids = new Set();
  for (const p of projects) {
    if (String(p.ownerId) !== uid) ids.add(String(p.ownerId));
    for (const c of p.collaboratorIds || []) {
      if (String(c) !== uid) ids.add(String(c));
    }
  }
  return [...ids];
}

router.get('/genres', (req, res) => {
  res.json({ genres: PROJECT_GENRES });
});

router.get('/suggestions', authRequired, async (req, res) => {
  try {
    const me = await User.findById(req.userId).select('genres');
    if (!me) return res.status(404).json({ error: 'User not found' });

    const following = await Follow.find({ followerId: req.userId }).select('followingId');
    const excludedIds = new Set([
      String(req.userId),
      ...following.map((row) => String(row.followingId)),
    ]);

    const users = await User.find({
      _id: { $nin: [...excludedIds] },
    })
      .select('name username avatarUrl bio genres')
      .sort({ createdAt: -1 })
      .limit(18);

    const myGenres = new Set((me.genres || []).map((entry) => String(entry)));
    const scored = users
      .map((user) => {
        const sharedGenres = (user.genres || []).filter((genre) => myGenres.has(String(genre)));
        return {
          user: toPublicUser(req, user),
          sharedGenres,
          score: sharedGenres.length,
        };
      })
      .sort((a, b) => b.score - a.score || a.user.name.localeCompare(b.user.name));

    res.json({
      users: scored.map((entry) => ({
        ...entry.user,
        sharedGenres: entry.sharedGenres,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/me', authRequired, (req, res, next) => {
  req.uploadType = 'avatar';
  next();
}, upload.single('avatar'), async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'Not found' });
    const previousAvatar = {
      url: user.avatarUrl,
      publicId: user.avatarPublicId,
      resourceType: user.avatarResourceType,
    };
    const removeAvatar = String(req.body.removeAvatar || '').toLowerCase() === 'true';
    if (req.body.name) user.name = String(req.body.name).trim();
    if (req.body.bio !== undefined) user.bio = String(req.body.bio);
    if (req.body.username) {
      const u = String(req.body.username).toLowerCase().trim().replace(/\s+/g, '_');
      const taken = await User.findOne({ username: u, _id: { $ne: user._id } });
      if (taken) return res.status(409).json({ error: 'Username taken' });
      user.username = u;
    }
    if (req.body.genres !== undefined) {
      user.genres = String(req.body.genres)
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean);
    }

    if (req.file) {
      const nextAvatarAsset = await uploadBuffer(req.file, {
        folder: 'avatars',
        resourceType: 'image',
      });
      user.avatarUrl = nextAvatarAsset.url;
      user.avatarPublicId = nextAvatarAsset.publicId;
      user.avatarResourceType = nextAvatarAsset.resourceType;
    } else if (removeAvatar) {
      user.avatarUrl = '';
      user.avatarPublicId = '';
      user.avatarResourceType = 'image';
    }

    await user.save();

    if (previousAvatar.url && previousAvatar.url !== user.avatarUrl) {
      await deleteStoredAsset(previousAvatar);
    }

    res.json({ user: toPublicUser(req, user) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.get('/me/settings', authRequired, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('settings');
    if (!user) return res.status(404).json({ error: 'Not found' });
    res.json({ settings: normalizeUserSettings(user.settings) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/me/settings', authRequired, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'Not found' });

    const current = normalizeUserSettings(user.settings);
    const incoming =
      req.body && typeof req.body === 'object' && !Array.isArray(req.body)
        ? req.body
        : {};
    const notifications =
      incoming.notifications &&
          typeof incoming.notifications === 'object' &&
          !Array.isArray(incoming.notifications)
        ? incoming.notifications
        : {};

    user.settings = {
      themeMode:
        incoming.themeMode == null
          ? current.themeMode
          : normalizeThemeMode(incoming.themeMode),
      notifications: {
        enabled: notifications.enabled ?? current.notifications.enabled,
        directMessages:
          notifications.directMessages ?? current.notifications.directMessages,
        workspaceMessages:
          notifications.workspaceMessages ??
          current.notifications.workspaceMessages,
      },
    };
    user.markModified('settings');
    await user.save();

    const publicUser = toPublicUser(req, user);
    res.json({
      settings: publicUser.settings,
      user: publicUser,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/by-username/:username', authRequired, async (req, res) => {
  try {
    const username = String(req.params.username).toLowerCase();
    const user = await User.findOne({ username }).select('-passwordHash');
    if (!user) return res.status(404).json({ error: 'User not found' });
    const me = String(req.userId);
    const isFollowing = !!(await Follow.findOne({ followerId: me, followingId: user._id }));
    const followsYou = !!(await Follow.findOne({ followerId: user._id, followingId: me }));
    const followerCount = await Follow.countDocuments({ followingId: user._id });
    const followingCount = await Follow.countDocuments({ followerId: user._id });

    const projectPartnerIds = await collabPartnersFromProjects(user._id);
    const net = (user.networkPartnerIds || []).map((id) => String(id));
    const partnerIdSet = new Set([...projectPartnerIds, ...net]);
    partnerIdSet.delete(String(user._id));
    const partners = await User.find({ _id: { $in: [...partnerIdSet] } })
      .select('name username avatarUrl')
      .limit(50);

    res.json({
      user: toPublicUser(req, user),
      isFollowing,
      followsYou,
      followerCount,
      followingCount,
      collabWith: partners.map((p) => toPublicUser(req, p)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/public', authRequired, async (req, res) => {
  try {
    const user = await User.findById(req.params.id).select('-passwordHash');
    if (!user) return res.status(404).json({ error: 'User not found' });
    const me = String(req.userId);
    const isFollowing = !!(await Follow.findOne({ followerId: me, followingId: user._id }));
    const followsYou = !!(await Follow.findOne({ followerId: user._id, followingId: me }));
    const followerCount = await Follow.countDocuments({ followingId: user._id });
    const followingCount = await Follow.countDocuments({ followerId: user._id });
    const projectPartnerIds = await collabPartnersFromProjects(user._id);
    const net = (user.networkPartnerIds || []).map((id) => String(id));
    const partnerIdSet = new Set([...projectPartnerIds, ...net]);
    partnerIdSet.delete(String(user._id));
    const partners = await User.find({ _id: { $in: [...partnerIdSet] } })
      .select('name username avatarUrl')
      .limit(50);
    res.json({
      user: toPublicUser(req, user),
      isFollowing,
      followsYou,
      followerCount,
      followingCount,
      collabWith: partners.map((p) => toPublicUser(req, p)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/follow', authRequired, async (req, res) => {
  try {
    const followingId = req.params.id;
    if (String(followingId) === String(req.userId)) {
      return res.status(400).json({ error: 'Cannot follow yourself' });
    }
    const target = await User.findById(followingId);
    if (!target) return res.status(404).json({ error: 'User not found' });
    await Follow.updateOne(
      { followerId: req.userId, followingId },
      { $setOnInsert: { followerId: req.userId, followingId } },
      { upsert: true }
    );
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 11000) return res.json({ ok: true });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id/follow', authRequired, async (req, res) => {
  try {
    await Follow.deleteOne({ followerId: req.userId, followingId: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/followers', authRequired, async (req, res) => {
  try {
    const rows = await Follow.find({ followingId: req.params.id }).populate(
      'followerId',
      'name username avatarUrl bio genres'
    );
    const users = rows.map((r) => toPublicUser(req, r.followerId)).filter(Boolean);
    res.json({ users });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/following', authRequired, async (req, res) => {
  try {
    const rows = await Follow.find({ followerId: req.params.id }).populate(
      'followingId',
      'name username avatarUrl bio genres'
    );
    const users = rows.map((r) => toPublicUser(req, r.followingId)).filter(Boolean);
    res.json({ users });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
