const express = require('express');
const User = require('../models/User');
const Project = require('../models/Project');
const { authRequired } = require('../middleware/auth');
const { toPublicUser } = require('../utils/toPublicUser');
const { publicUrl } = require('../utils/publicUrl');

const router = express.Router();

router.get('/', authRequired, async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const type = String(req.query.type || 'all');
    if (!q) return res.json({ users: [], projects: [] });

    const users = [];
    const projects = [];

    if (type === 'all' || type === 'user') {
      const u = await User.find({
        $or: [
          { username: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
          { name: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
        ],
      })
        .select('name username avatarUrl bio genres')
        .limit(20);
      users.push(...u.map((x) => toPublicUser(req, x)));
    }

    if (type === 'all' || type === 'project') {
      const p = await Project.find({
        $or: [
          { title: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
          { description: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
          { genres: q },
        ],
      })
        .sort({ updatedAt: -1 })
        .limit(20)
        .populate('ownerId', 'name username avatarUrl');

      for (const proj of p) {
        const o = proj.toObject();
        projects.push({
          id: String(o._id),
          title: o.title,
          description: o.description,
          genres: o.genres,
          imageUrls: (o.imageUrls || []).map((url) => publicUrl(req, url)),
          owner: toPublicUser(req, proj.ownerId),
        });
      }
    }

    res.json({ users, projects });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
