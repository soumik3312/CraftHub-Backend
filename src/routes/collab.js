const express = require('express');
const CollabRequest = require('../models/CollabRequest');
const Project = require('../models/Project');
const User = require('../models/User');
const { authRequired } = require('../middleware/auth');
const { toPublicUser } = require('../utils/toPublicUser');
const { publicUrl } = require('../utils/publicUrl');
const { autoCreateProjectWorkspace } = require('../utils/projectWorkspace');
const { ensureDirectConversation } = require('../utils/directConversation');

const router = express.Router();
const MAX_PROJECT_MEMBERS = 4;

async function userCategorySet(userId, userDoc = null) {
  const user =
    userDoc ||
    (await User.findById(userId).select('genres').lean());
  const cats = new Set((user?.genres || []).map((g) => String(g).trim()).filter(Boolean));

  const projects = await Project.find({
    $or: [{ ownerId: userId }, { collaboratorIds: userId }],
  })
    .select('genres')
    .lean();

  for (const project of projects) {
    for (const genre of project.genres || []) {
      const value = String(genre).trim();
      if (value) cats.add(value);
    }
  }

  return cats;
}

function sharedCategories(left, right) {
  const out = [];
  for (const value of left) {
    if (right.has(value)) out.push(value);
  }
  return out;
}

async function finalizeConnection(request) {
  await User.updateOne(
    { _id: request.fromUserId },
    { $addToSet: { networkPartnerIds: request.toUserId } }
  );
  await User.updateOne(
    { _id: request.toUserId },
    { $addToSet: { networkPartnerIds: request.fromUserId } }
  );

  if (request.type === 'project_invite' && request.projectId) {
    await Project.updateOne(
      { _id: request.projectId },
      { $addToSet: { collaboratorIds: request.toUserId } }
    );
  }

  if (request.type === 'project_request' && request.projectId) {
    await Project.updateOne(
      { _id: request.projectId },
      { $addToSet: { collaboratorIds: request.fromUserId } }
    );
  }
}

function projectMemberIds(project) {
  return new Set([
    String(project.ownerId),
    ...(project.collaboratorIds || []).map((id) => String(id)),
  ]);
}

function projectIsFull(project, joiningUserId = null) {
  const members = projectMemberIds(project);
  if (joiningUserId && members.has(String(joiningUserId))) return false;
  return members.size >= MAX_PROJECT_MEMBERS;
}

function toPublicRequest(req, r) {
  const o = r.toObject ? r.toObject() : { ...r };
  o.id = String(o._id);
  delete o._id;
  delete o.__v;
  if (o.projectId && typeof o.projectId === 'object' && o.projectId.title) {
    const p = o.projectId;
    o.project = {
      id: String(p._id),
      title: p.title,
      imageUrls: (p.imageUrls || []).map((u) => publicUrl(req, u)),
    };
    delete o.projectId;
  } else if (o.projectId) {
    o.projectId = String(o.projectId);
  }
  o.fromUserId = o.fromUserId && o.fromUserId._id ? toPublicUser(req, o.fromUserId) : o.fromUserId;
  o.toUserId = o.toUserId && o.toUserId._id ? toPublicUser(req, o.toUserId) : o.toUserId;
  return o;
}

router.get('/match', authRequired, async (req, res) => {
  try {
    const me = await User.findById(req.userId).select('genres').lean();
    if (!me) return res.status(404).json({ error: 'Not found' });
    const myCategories = await userCategorySet(req.userId, me);
    if (!myCategories.size) {
      return res.json({ users: [], message: 'Add genres to your profile for better matches' });
    }

    const profileCandidates = await User.find({
      _id: { $ne: req.userId },
      genres: { $in: [...myCategories] },
    })
      .select('name username avatarUrl bio genres')
      .lean()
      .limit(40);

    const projectRows = await Project.find({
      genres: { $in: [...myCategories] },
    })
      .select('ownerId collaboratorIds')
      .lean();

    const candidateIdSet = new Set(profileCandidates.map((u) => String(u._id)));
    for (const row of projectRows) {
      if (String(row.ownerId) !== String(req.userId)) {
        candidateIdSet.add(String(row.ownerId));
      }
      for (const collaboratorId of row.collaboratorIds || []) {
        if (String(collaboratorId) !== String(req.userId)) {
          candidateIdSet.add(String(collaboratorId));
        }
      }
    }

    const users = await User.find({
      _id: { $in: [...candidateIdSet], $ne: req.userId },
    })
      .select('name username avatarUrl bio genres')
      .lean()
      .limit(40);

    const scored = [];
    for (const user of users) {
      const theirCategories = await userCategorySet(user._id, user);
      const overlap = sharedCategories(myCategories, theirCategories);
      if (!overlap.length) continue;
      scored.push({
        user,
        overlap,
      });
    }

    scored.sort((a, b) => b.overlap.length - a.overlap.length);
    res.json({
      users: scored.map((entry) => ({
        ...toPublicUser(req, entry.user),
        sharedCategories: entry.overlap,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/requests', authRequired, async (req, res) => {
  try {
    const toUserId = req.body.toUserId;
    const requestedType = String(req.body.type || '').trim();
    const type =
      requestedType === 'project_invite' || requestedType === 'project_request'
        ? requestedType
        : '';
    const projectId = req.body.projectId || null;
    const message = String(req.body.message || '').trim();
    if (!toUserId) return res.status(400).json({ error: 'toUserId required' });
    if (!type) {
      return res.status(400).json({ error: 'Collab requests must be sent from a project context' });
    }
    if (String(toUserId) === String(req.userId)) {
      return res.status(400).json({ error: 'Invalid recipient' });
    }
    const target = await User.findById(toUserId).select('genres');
    if (!target) return res.status(404).json({ error: 'User not found' });

    const myCategories = await userCategorySet(req.userId);
    const targetCategories = await userCategorySet(toUserId, target);
    if (!sharedCategories(myCategories, targetCategories).length) {
      return res.status(403).json({ error: 'Collab requests are allowed only for matching categories' });
    }

    if (!projectId) {
      return res.status(400).json({ error: 'projectId required for project-based collaboration' });
    }

    const project = await Project.findById(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const uid = String(req.userId);
    const isOwner = String(project.ownerId) === uid;
    const isCollab = (project.collaboratorIds || []).some((c) => String(c) === uid);
    const projectCategories = new Set((project.genres || []).map((g) => String(g).trim()).filter(Boolean));

    if (type === 'project_invite') {
      if (!isOwner && !isCollab) return res.status(403).json({ error: 'Not allowed for this project' });
      if (projectIsFull(project, toUserId)) {
        return res.status(409).json({ error: 'This project already has the maximum 4 collaborators.' });
      }
      if ((project.collaboratorIds || []).some((c) => String(c) === String(toUserId))) {
        return res.status(409).json({ error: 'This user is already collaborating on the project' });
      }
      if (String(project.ownerId) === String(toUserId)) {
        return res.status(400).json({ error: 'Project owner is already part of the project' });
      }

      if (projectCategories.size && !sharedCategories(projectCategories, targetCategories).length) {
        return res.status(403).json({ error: 'Invite only collaborators with overlapping project categories' });
      }
    }

    if (type === 'project_request') {
      if (projectIsFull(project, req.userId)) {
        return res.status(409).json({ error: 'This project already has the maximum 4 collaborators.' });
      }
      if (isOwner || isCollab) {
        return res.status(400).json({ error: 'You are already part of this project' });
      }
      if (String(project.ownerId) !== String(toUserId)) {
        return res.status(403).json({ error: 'Project join requests must be sent to the project owner' });
      }
      if (projectCategories.size && !sharedCategories(projectCategories, myCategories).length) {
        return res.status(403).json({ error: 'You can request only projects that overlap with your categories' });
      }
    }

    const pairFilters = [
      {
        fromUserId: req.userId,
        toUserId,
        projectId,
      },
      {
        fromUserId: toUserId,
        toUserId: req.userId,
        projectId,
      },
    ];
    const existing = await CollabRequest.findOne({
      $or: pairFilters,
      status: { $in: ['pending', 'accepted', 'connected'] },
    });
    if (existing) {
      if (existing.status === 'connected') {
        return res.status(409).json({ error: 'Collaboration is already connected' });
      }
      return res.status(409).json({ error: 'A collaboration request is already in progress' });
    }

    const doc = await CollabRequest.create({
      fromUserId: req.userId,
      toUserId,
      projectId,
      type,
      message,
      status: 'pending',
    });
    const conversation = await ensureDirectConversation(req.userId, toUserId);
    const populated = await CollabRequest.findById(doc._id)
      .populate('fromUserId', 'name username avatarUrl')
      .populate('toUserId', 'name username avatarUrl')
      .populate('projectId', 'title imageUrls');
    res.status(201).json({
      request: toPublicRequest(req, populated),
      conversationId: String(conversation._id),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/requests/incoming', authRequired, async (req, res) => {
  try {
    const list = await CollabRequest.find({
      toUserId: req.userId,
      status: { $in: ['pending', 'accepted'] },
    })
      .sort({ createdAt: -1 })
      .populate('fromUserId', 'name username avatarUrl bio genres')
      .populate('toUserId', 'name username avatarUrl')
      .populate('projectId', 'title imageUrls');
    res.json({ requests: list.map((r) => toPublicRequest(req, r)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/requests/outgoing', authRequired, async (req, res) => {
  try {
    const list = await CollabRequest.find({
      fromUserId: req.userId,
      status: { $in: ['pending', 'accepted'] },
    })
      .sort({ createdAt: -1 })
      .populate('fromUserId', 'name username avatarUrl')
      .populate('toUserId', 'name username avatarUrl bio genres')
      .populate('projectId', 'title imageUrls');
    res.json({ requests: list.map((r) => toPublicRequest(req, r)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/requests/:id/accept', authRequired, async (req, res) => {
  try {
    const r = await CollabRequest.findById(req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found' });
    const project = r.projectId ? await Project.findById(r.projectId) : null;
    const joiningUserId =
      r.type === 'project_invite' ? r.toUserId : r.type === 'project_request' ? r.fromUserId : null;
    if (project && joiningUserId && projectIsFull(project, joiningUserId)) {
      return res.status(409).json({ error: 'This project already has the maximum 4 collaborators.' });
    }

    if (r.status === 'pending') {
      if (String(r.toUserId) !== String(req.userId)) {
        return res.status(403).json({ error: 'Only the recipient can accept this request first' });
      }
      r.status = 'accepted';
      await r.save();
      return res.json({
        ok: true,
        status: r.status,
        message: 'First acceptance complete. Waiting for the sender to confirm.',
      });
    }

    if (r.status === 'accepted') {
      if (String(r.fromUserId) !== String(req.userId)) {
        return res.status(403).json({ error: 'Only the sender can confirm after the recipient accepts' });
      }
      r.status = 'connected';
      await r.save();
      await finalizeConnection(r);
      const workspaceResult = r.projectId
        ? await autoCreateProjectWorkspace(req, r.projectId, { triggeredByUserId: req.userId })
        : { created: false };
      return res.json({
        ok: true,
        status: r.status,
        message: workspaceResult.created
          ? 'Collaboration connected. Chat and shared GitHub workspace are now ready.'
          : workspaceResult.reason === 'too_many_collaborators'
            ? 'Collaboration connected, but the project has more than 4 members so the shared workspace was not created.'
          : 'Collaboration connected. Chat is now available.',
      });
    }

    return res.status(400).json({ error: 'Already handled' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/requests/:id/reject', authRequired, async (req, res) => {
  try {
    const r = await CollabRequest.findById(req.params.id);
    if (!r) return res.status(404).json({ error: 'Not found' });
    if (String(r.toUserId) !== String(req.userId)) {
      return res.status(403).json({ error: 'Not your request' });
    }
    if (r.status !== 'pending') return res.status(400).json({ error: 'Already handled' });
    r.status = 'rejected';
    await r.save();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
