const express = require('express');
const mongoose = require('mongoose');
const Project = require('../models/Project');
const User = require('../models/User');
const { authRequired } = require('../middleware/auth');
const { upload } = require('../multerUpload');
const { uploadBuffer } = require('../utils/cloudinary');
const { deleteStoredAsset } = require('../utils/deleteStoredAsset');
const { publicUrl } = require('../utils/publicUrl');
const { toPublicUser } = require('../utils/toPublicUser');
const { githubRequest } = require('../utils/githubApi');
const { autoCreateProjectWorkspace } = require('../utils/projectWorkspace');

const router = express.Router();
const MAX_PROJECT_MEMBERS = 4;

function toIdString(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value._id) return String(value._id);
  return String(value);
}

function toPublicProject(req, p) {
  const o = p.toObject ? p.toObject() : { ...p };
  o.id = String(o._id);
  delete o._id;
  delete o.__v;
  o.imageUrls = (o.imageUrls || []).map((u) => publicUrl(req, u));
  delete o.imagePublicIds;
  delete o.imageResourceTypes;
  if (o.sourceFile && o.sourceFile.url) {
    o.sourceFile = {
      url: publicUrl(req, o.sourceFile.url),
      originalName: o.sourceFile.originalName || '',
    };
  }
  const workspace = o.workspace || {};
  const contributions = (workspace.contributions || []).map((entry) => ({
    userId: toIdString(entry.userId),
    commitCount: Number(entry.commitCount || 0),
    lastSavedAt: entry.lastSavedAt || null,
    lastFilePath: entry.lastFilePath || '',
  }));
  o.workspace = {
    provider: workspace.provider || '',
    requestedRepoName: workspace.requestedRepoName || '',
    repoOwner: workspace.repoOwner || '',
    repoName: workspace.repoName || '',
    repoFullName: workspace.repoFullName || '',
    repoUrl: workspace.repoUrl || '',
    editorUrl: workspace.editorUrl || '',
    defaultBranch: workspace.defaultBranch || 'main',
    conversationId: workspace.conversationId ? String(workspace.conversationId) : null,
    createdByUserId: workspace.createdByUserId ? String(workspace.createdByUserId) : null,
    createdAt: workspace.createdAt || null,
    contributions,
    totalContributionCount: contributions.reduce(
      (sum, entry) => sum + Number(entry.commitCount || 0),
      0
    ),
  };
  o.githubUrl = o.githubUrl || o.workspace.repoUrl || '';
  o.techStack = (o.techStack || []).map((entry) => String(entry || '').trim()).filter(Boolean);
  o.likeCount = (o.likeUserIds || []).length;
  o.commentCount = (o.comments || []).length;
  o.likedByMe = (o.likeUserIds || []).some((id) => String(id) === String(req.userId));
  const memberIds = new Set([
    toIdString(o.ownerId),
    ...((o.collaboratorIds || []).map((id) => toIdString(id))),
  ]);
  o.memberCount = memberIds.size;
  o.maxMembers = MAX_PROJECT_MEMBERS;
  o.slotsLeft = Math.max(0, MAX_PROJECT_MEMBERS - memberIds.size);
  return o;
}

async function projectWithRelations(req, projectId) {
  const project = await Project.findById(projectId)
    .populate('ownerId', 'name username avatarUrl bio genres githubConnected githubUsername githubProfileUrl')
    .populate('collaboratorIds', 'name username avatarUrl githubConnected githubUsername githubProfileUrl');
  if (!project) return null;
  return {
    ...toPublicProject(req, project),
    owner: toPublicUser(req, project.ownerId),
    collaborators: (project.collaboratorIds || []).map((u) => toPublicUser(req, u)),
  };
}

function toPublicProjectComment(req, comment, usersById = new Map()) {
  const userId = toIdString(comment.userId);
  return {
    id: `${userId}:${new Date(comment.createdAt || Date.now()).toISOString()}`,
    userId,
    text: String(comment.text || '').trim(),
    createdAt: comment.createdAt || null,
    user: usersById.get(userId) || null,
  };
}

async function canEditProject(userId, project) {
  const uid = String(userId);
  if (String(project.ownerId) === uid) return true;
  return (project.collaboratorIds || []).some((c) => String(c) === uid);
}

function ensureWorkspaceContributionState(project) {
  if (!project.workspace) project.workspace = {};
  if (!Array.isArray(project.workspace.contributions)) {
    project.workspace.contributions = [];
  }
}

function repoContentPath(owner, repo, filePath = '') {
  const encodedRoot = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents`;
  const normalized = String(filePath || '').trim().replace(/^\/+/, '');
  if (!normalized) return encodedRoot;
  return `${encodedRoot}/${normalized.split('/').map((segment) => encodeURIComponent(segment)).join('/')}`;
}

async function workspaceAccess(projectId, userId) {
  const project = await Project.findById(projectId);
  if (!project) return { error: { status: 404, message: 'Project not found' } };

  const allowed =
    String(project.ownerId) === String(userId) ||
    (project.collaboratorIds || []).some((id) => String(id) === String(userId));
  if (!allowed) {
    return { error: { status: 403, message: 'You are not part of this project workspace' } };
  }

  if (!project.workspace?.repoOwner || !project.workspace?.repoName) {
    return { error: { status: 409, message: 'Shared workspace is not ready for this project yet' } };
  }

  const user = await User.findById(userId).select('githubConnected githubUsername githubAccessToken');
  if (!user || !user.githubConnected || !user.githubAccessToken) {
    return { error: { status: 409, message: 'Connect GitHub first to edit the shared workspace' } };
  }

  return { project, user };
}

router.get('/explore', authRequired, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 12, 30);
    const cursor = req.query.cursor;
    const filter = {};
    if (cursor && mongoose.Types.ObjectId.isValid(cursor)) {
      const last = await Project.findById(cursor).select('exploreScore');
      if (last) {
        filter.$or = [
          { exploreScore: { $gt: last.exploreScore } },
          { exploreScore: last.exploreScore, _id: { $gt: cursor } },
        ];
      }
    }
    const items = await Project.find(filter)
      .sort({ exploreScore: 1, _id: 1 })
      .limit(limit)
      .populate('ownerId', 'name username avatarUrl githubConnected githubUsername githubProfileUrl')
      .populate('collaboratorIds', 'name username avatarUrl githubConnected githubUsername githubProfileUrl');

    const nextCursor = items.length ? String(items[items.length - 1]._id) : null;
    res.json({
      projects: items.map((p) => ({
        ...toPublicProject(req, p),
        owner: toPublicUser(req, p.ownerId),
        collaborators: (p.collaboratorIds || []).map((u) => toPublicUser(req, u)),
      })),
      nextCursor,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/mine', authRequired, async (req, res) => {
  try {
    const owned = await Project.find({ ownerId: req.userId })
      .sort({ updatedAt: -1 })
      .populate('collaboratorIds', 'name username avatarUrl githubConnected githubUsername githubProfileUrl');
    const collab = await Project.find({
      collaboratorIds: req.userId,
      ownerId: { $ne: req.userId },
    })
      .sort({ updatedAt: -1 })
      .populate('ownerId', 'name username avatarUrl githubConnected githubUsername githubProfileUrl')
      .populate('collaboratorIds', 'name username avatarUrl githubConnected githubUsername githubProfileUrl');

    const map = (p) => ({
      ...toPublicProject(req, p),
      owner: p.ownerId ? toPublicUser(req, p.ownerId) : null,
      collaborators: (p.collaboratorIds || []).map((u) => toPublicUser(req, u)),
    });

    res.json({
      owned: owned.map(map),
      collaborating: collab.map(map),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/user/:userId', authRequired, async (req, res) => {
  try {
    const uid = req.params.userId;
    const list = await Project.find({
      $or: [{ ownerId: uid }, { collaboratorIds: uid }],
    })
      .sort({ updatedAt: -1 })
      .populate('ownerId', 'name username avatarUrl githubConnected githubUsername githubProfileUrl')
      .populate('collaboratorIds', 'name username avatarUrl githubConnected githubUsername githubProfileUrl');
    res.json({
      projects: list.map((p) => ({
        ...toPublicProject(req, p),
        owner: toPublicUser(req, p.ownerId),
        collaborators: (p.collaboratorIds || []).map((u) => toPublicUser(req, u)),
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', authRequired, async (req, res) => {
  try {
    const project = await projectWithRelations(req, req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    res.json({ project });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.get('/:id/comments', authRequired, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id).select('comments');
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const commentUserIds = [...new Set((project.comments || []).map((entry) => toIdString(entry.userId)).filter(Boolean))];
    const users = await User.find({ _id: { $in: commentUserIds } }).select(
      'name username avatarUrl githubConnected githubUsername githubProfileUrl'
    );
    const usersById = new Map(users.map((user) => [String(user._id), toPublicUser(req, user)]));

    res.json({
      comments: (project.comments || [])
        .slice()
        .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
        .map((comment) => toPublicProjectComment(req, comment, usersById)),
      commentCount: (project.comments || []).length,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/:id/comment', authRequired, async (req, res) => {
  try {
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Comment text required' });

    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    project.comments = project.comments || [];
    project.comments.push({
      userId: req.userId,
      text,
      createdAt: new Date(),
    });
    project.updatedAt = new Date();
    await project.save();

    const user = await User.findById(req.userId).select(
      'name username avatarUrl githubConnected githubUsername githubProfileUrl'
    );
    const comment = project.comments[project.comments.length - 1];

    res.status(201).json({
      comment: toPublicProjectComment(
        req,
        comment,
        new Map([[String(req.userId), toPublicUser(req, user)]])
      ),
      commentCount: (project.comments || []).length,
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.post('/:id/like', authRequired, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const current = new Set((project.likeUserIds || []).map((id) => String(id)));
    current.add(String(req.userId));
    project.likeUserIds = [...current];
    await project.save();
    res.json({
      likeCount: (project.likeUserIds || []).length,
      likedByMe: true,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id/like', authRequired, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    project.likeUserIds = (project.likeUserIds || []).filter(
      (id) => String(id) !== String(req.userId)
    );
    await project.save();
    res.json({
      likeCount: (project.likeUserIds || []).length,
      likedByMe: false,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/workspace/create', authRequired, async (req, res) => {
  try {
    const result = await autoCreateProjectWorkspace(req, req.params.id, {
      triggeredByUserId: req.userId,
      requireOwnerRequest: true,
    });

    if (result.reason === 'not_configured') {
      return res.status(503).json({ error: 'GitHub integration is not configured on the server' });
    }
    if (result.reason === 'project_missing') {
      return res.status(404).json({ error: 'Project not found' });
    }
    if (result.reason === 'owner_only') {
      return res.status(403).json({ error: 'Only the project owner can create the GitHub workspace' });
    }
    if (result.reason === 'owner_github_missing') {
      return res.status(409).json({ error: 'Connect the owner GitHub account before creating a shared workspace' });
    }
    if (result.reason === 'no_collaborators') {
      return res.status(400).json({ error: 'Add at least one collaborator before creating the GitHub workspace' });
    }
    if (result.reason === 'too_many_collaborators') {
      return res.status(409).json({ error: 'A project can have at most 4 members in one shared workspace.' });
    }
    if (result.reason === 'collaborator_github_missing') {
      return res.status(409).json({
        error: `These collaborators must connect GitHub first: ${(result.missingUsers || []).join(', ')}`,
      });
    }

    const projectId = result.project?._id || req.params.id;
    const populated = await Project.findById(projectId)
      .populate('ownerId', 'name username avatarUrl bio genres githubConnected githubUsername githubProfileUrl')
      .populate('collaboratorIds', 'name username avatarUrl githubConnected githubUsername githubProfileUrl');

    res.status(result.created ? 201 : 200).json({
      project: {
        ...toPublicProject(req, populated),
        owner: toPublicUser(req, populated.ownerId),
        collaborators: (populated.collaboratorIds || []).map((u) => toPublicUser(req, u)),
      },
      conversationId: result.conversationId,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id/workspace/name', authRequired, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (!(await canEditProject(req.userId, project))) {
      return res.status(403).json({ error: 'Only project collaborators can set the shared repository name' });
    }
    if (project.workspace?.repoUrl) {
      return res.status(409).json({ error: 'Repository name cannot be changed after the workspace is created' });
    }

    const requestedRepoName = String(req.body.repoName || '').trim();
    if (!requestedRepoName) {
      return res.status(400).json({ error: 'repoName required' });
    }

    project.workspace = {
      ...(project.workspace?.toObject ? project.workspace.toObject() : project.workspace || {}),
      requestedRepoName,
      createdByUserId: req.userId,
    };
    project.updatedAt = new Date();
    await project.save();

    const populated = await Project.findById(project._id)
      .populate('ownerId', 'name username avatarUrl bio genres githubConnected githubUsername githubProfileUrl')
      .populate('collaboratorIds', 'name username avatarUrl githubConnected githubUsername githubProfileUrl');

    res.json({
      project: {
        ...toPublicProject(req, populated),
        owner: toPublicUser(req, populated.ownerId),
        collaborators: (populated.collaboratorIds || []).map((u) => toPublicUser(req, u)),
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/workspace/tree', authRequired, async (req, res) => {
  try {
    const access = await workspaceAccess(req.params.id, req.userId);
    if (access.error) return res.status(access.error.status).json({ error: access.error.message });

    const pathValue = String(req.query.path || '').trim();
    const data = await githubRequest(
      repoContentPath(access.project.workspace.repoOwner, access.project.workspace.repoName, pathValue),
      { token: access.user.githubAccessToken }
    );

    const entries = Array.isArray(data) ? data : [data];
    res.json({
      path: pathValue,
      entries: entries.map((entry) => ({
        name: entry.name,
        path: entry.path,
        sha: entry.sha || '',
        type: entry.type,
        size: entry.size || 0,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/workspace/file', authRequired, async (req, res) => {
  try {
    const access = await workspaceAccess(req.params.id, req.userId);
    if (access.error) return res.status(access.error.status).json({ error: access.error.message });

    const pathValue = String(req.query.path || '').trim();
    if (!pathValue) return res.status(400).json({ error: 'path required' });

    const data = await githubRequest(
      repoContentPath(access.project.workspace.repoOwner, access.project.workspace.repoName, pathValue),
      { token: access.user.githubAccessToken }
    );

    const content = String(data.content || '').replace(/\n/g, '');
    res.json({
      path: data.path || pathValue,
      sha: data.sha || '',
      encoding: data.encoding || 'base64',
      content: Buffer.from(content, data.encoding || 'base64').toString('utf8'),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id/workspace/file', authRequired, async (req, res) => {
  try {
    const access = await workspaceAccess(req.params.id, req.userId);
    if (access.error) return res.status(access.error.status).json({ error: access.error.message });

    const pathValue = String(req.body.path || '').trim();
    const content = String(req.body.content || '');
    const message = String(req.body.message || '').trim() || `Update ${pathValue} from Craft Hub`;
    const sha = String(req.body.sha || '').trim();
    if (!pathValue) return res.status(400).json({ error: 'path required' });

    const payload = await githubRequest(
      repoContentPath(access.project.workspace.repoOwner, access.project.workspace.repoName, pathValue),
      {
        method: 'PUT',
        token: access.user.githubAccessToken,
        body: {
          message,
          content: Buffer.from(content, 'utf8').toString('base64'),
          ...(sha ? { sha } : {}),
        },
      }
    );

    ensureWorkspaceContributionState(access.project);
    const existingContribution = access.project.workspace.contributions.find(
      (entry) => String(entry.userId) === String(req.userId)
    );
    if (existingContribution) {
      existingContribution.commitCount = Number(existingContribution.commitCount || 0) + 1;
      existingContribution.lastSavedAt = new Date();
      existingContribution.lastFilePath = pathValue;
    } else {
      access.project.workspace.contributions.push({
        userId: req.userId,
        commitCount: 1,
        lastSavedAt: new Date(),
        lastFilePath: pathValue,
      });
    }
    access.project.updatedAt = new Date();
    await access.project.save();

    res.json({
      ok: true,
      path: pathValue,
      sha: payload.content?.sha || '',
      commitUrl: payload.commit?.html_url || '',
      contributionCount:
        access.project.workspace.contributions.find((entry) => String(entry.userId) === String(req.userId))
          ?.commitCount || 0,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', authRequired, (req, res, next) => {
  req.uploadType = 'project';
  next();
}, upload.fields([
  { name: 'images', maxCount: 8 },
  { name: 'source', maxCount: 1 },
]), async (req, res) => {
  try {
    const title = (req.body.title || '').trim();
    if (!title) return res.status(400).json({ error: 'title required' });
    const description = (req.body.description || '').trim();
    const githubUrl = String(req.body.githubUrl || '').trim();
    const workspaceRepoName = String(req.body.workspaceRepoName || '').trim();
    const genres = String(req.body.genres || '')
      .split(',')
      .map((g) => g.trim())
      .filter(Boolean);
    const techStack = String(req.body.techStack || '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    const uploadedImages = await Promise.all(
      (req.files?.images || []).map((file) =>
        uploadBuffer(file, {
          folder: 'projects/images',
          resourceType: 'image',
        })
      )
    );
    let sourceFile = {
      url: '',
      originalName: '',
      publicId: '',
      resourceType: 'raw',
    };
    const src = req.files?.source?.[0];
    if (src) {
      const uploadedSource = await uploadBuffer(src, {
        folder: 'projects/source',
        resourceType: 'raw',
      });
      sourceFile = {
        url: uploadedSource.url,
        originalName: src.originalname,
        publicId: uploadedSource.publicId,
        resourceType: uploadedSource.resourceType,
      };
    }
    const project = await Project.create({
      ownerId: req.userId,
      title,
      description,
      githubUrl,
      genres,
      techStack,
      imageUrls: uploadedImages.map((asset) => asset.url),
      imagePublicIds: uploadedImages.map((asset) => asset.publicId),
      imageResourceTypes: uploadedImages.map((asset) => asset.resourceType),
      sourceFile,
      collaboratorIds: [],
      likeUserIds: [],
      comments: [],
      workspace: {
        requestedRepoName: workspaceRepoName,
      },
    });
    const populated = await Project.findById(project._id)
      .populate('ownerId', 'name username avatarUrl githubConnected githubUsername githubProfileUrl')
      .populate('collaboratorIds', 'name username avatarUrl githubConnected githubUsername githubProfileUrl');
    res.status(201).json({
      project: {
        ...toPublicProject(req, populated),
        owner: toPublicUser(req, populated.ownerId),
        collaborators: [],
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', authRequired, (req, res, next) => {
  req.uploadType = 'project';
  next();
}, upload.fields([
  { name: 'images', maxCount: 8 },
  { name: 'source', maxCount: 1 },
]), async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    if (!(await canEditProject(req.userId, project))) {
      return res.status(403).json({ error: 'No permission' });
    }
    const removedAssets = [];
    let replacedSource = null;
    if (req.body.title) project.title = String(req.body.title).trim();
    if (req.body.description !== undefined) project.description = String(req.body.description);
    if (req.body.githubUrl !== undefined) project.githubUrl = String(req.body.githubUrl).trim();
    if (req.body.workspaceRepoName !== undefined && !(project.workspace?.repoUrl)) {
      project.workspace = {
        ...(project.workspace?.toObject ? project.workspace.toObject() : project.workspace || {}),
        requestedRepoName: String(req.body.workspaceRepoName).trim(),
      };
    }
    if (req.body.genres !== undefined) {
      project.genres = String(req.body.genres)
        .split(',')
        .map((g) => g.trim())
        .filter(Boolean);
    }
    if (req.body.techStack !== undefined) {
      project.techStack = String(req.body.techStack)
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean);
    }
    if (req.body.removeImageIndexes !== undefined) {
      const idxs = String(req.body.removeImageIndexes)
        .split(',')
        .map((n) => Number(n.trim()))
        .filter((n) => !Number.isNaN(n));
      removedAssets.push(
        ...(project.imageUrls || [])
          .map((url, i) => ({
            url,
            publicId: (project.imagePublicIds || [])[i],
            resourceType: (project.imageResourceTypes || [])[i] || 'image',
            index: i,
          }))
          .filter((asset) => idxs.includes(asset.index))
      );
      project.imageUrls = (project.imageUrls || []).filter((_, i) => !idxs.includes(i));
      project.imagePublicIds = (project.imagePublicIds || []).filter(
        (_, i) => !idxs.includes(i)
      );
      project.imageResourceTypes = (project.imageResourceTypes || []).filter(
        (_, i) => !idxs.includes(i)
      );
    }
    const uploadedImages = await Promise.all(
      (req.files?.images || []).map((file) =>
        uploadBuffer(file, {
          folder: 'projects/images',
          resourceType: 'image',
        })
      )
    );
    if (uploadedImages.length) {
      project.imageUrls = [
        ...(project.imageUrls || []),
        ...uploadedImages.map((asset) => asset.url),
      ];
      project.imagePublicIds = [
        ...(project.imagePublicIds || []),
        ...uploadedImages.map((asset) => asset.publicId),
      ];
      project.imageResourceTypes = [
        ...(project.imageResourceTypes || []),
        ...uploadedImages.map((asset) => asset.resourceType),
      ];
    }
    const src = req.files?.source?.[0];
    if (src) {
      replacedSource = {
        url: project.sourceFile?.url || '',
        publicId: project.sourceFile?.publicId || '',
        resourceType: project.sourceFile?.resourceType || 'raw',
      };
      const uploadedSource = await uploadBuffer(src, {
        folder: 'projects/source',
        resourceType: 'raw',
      });
      project.sourceFile = {
        url: uploadedSource.url,
        originalName: src.originalname,
        publicId: uploadedSource.publicId,
        resourceType: uploadedSource.resourceType,
      };
    }
    project.updatedAt = new Date();
    await project.save();
    await Promise.all(removedAssets.map((asset) => deleteStoredAsset(asset)));
    if (replacedSource?.url && replacedSource.url !== project.sourceFile?.url) {
      await deleteStoredAsset(replacedSource);
    }
    const populated = await Project.findById(project._id)
      .populate('ownerId', 'name username avatarUrl githubConnected githubUsername githubProfileUrl')
      .populate('collaboratorIds', 'name username avatarUrl githubConnected githubUsername githubProfileUrl');
    res.json({
      project: {
        ...toPublicProject(req, populated),
        owner: toPublicUser(req, populated.ownerId),
        collaborators: (populated.collaboratorIds || []).map((u) => toPublicUser(req, u)),
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', authRequired, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id);
    if (!project) return res.status(404).json({ error: 'Not found' });
    if (String(project.ownerId) !== String(req.userId)) {
      return res.status(403).json({ error: 'Only owner can delete' });
    }
    await Project.deleteOne({ _id: project._id });
    await Promise.all(
      (project.imageUrls || []).map((url, index) =>
        deleteStoredAsset({
          url,
          publicId: (project.imagePublicIds || [])[index],
          resourceType: (project.imageResourceTypes || [])[index] || 'image',
        })
      )
    );
    if (project.sourceFile?.url) {
      await deleteStoredAsset({
        url: project.sourceFile.url,
        publicId: project.sourceFile.publicId,
        resourceType: project.sourceFile.resourceType || 'raw',
      });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
