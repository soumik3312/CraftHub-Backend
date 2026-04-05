const mongoose = require('mongoose');

const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Project = require('../models/Project');
const User = require('../models/User');
const {
  acceptRepoInvitation,
  addGithubCollaborator,
  createGithubRepo,
  githubConfigured,
  githubEditorUrl,
  listUserRepoInvitations,
  slugRepoName,
} = require('./githubApi');

const MAX_PROJECT_MEMBERS = 4;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function projectMemberCount(project) {
  return new Set([
    String(project.ownerId),
    ...(project.collaboratorIds || []).map((id) => String(id)),
  ]).size;
}

async function createWorkspaceRepo(token, requestedName, description, projectId) {
  const preferredName = slugRepoName(requestedName);
  try {
    return await createGithubRepo(token, preferredName, description);
  } catch (error) {
    if (error?.status !== 422) throw error;
    const fallbackName = `${preferredName}-${String(projectId).slice(-6)}`;
    return createGithubRepo(token, fallbackName, description);
  }
}

async function ensureWorkspaceConversation(project) {
  const participantIdSet = new Set([
    String(project.ownerId),
    ...(project.collaboratorIds || []).map((id) => String(id)),
  ]);
  const participantIds = [...participantIdSet].map((id) => new mongoose.Types.ObjectId(id));

  let conv = null;
  if (project.workspace?.conversationId) {
    conv = await Conversation.findById(project.workspace.conversationId);
  }
  if (!conv) {
    conv = await Conversation.findOne({ type: 'group', projectId: project._id });
  }

  if (!conv) {
    return Conversation.create({
      type: 'group',
      name: `${project.title} Workspace`,
      participantIds,
      memberState: participantIds.map((id) => ({ userId: id, lastReadAt: new Date() })),
      projectId: project._id,
      lastMessageAt: new Date(),
    });
  }

  const known = new Set((conv.participantIds || []).map((id) => String(id)));
  for (const id of participantIds) {
    if (!known.has(String(id))) {
      conv.participantIds.push(id);
      conv.memberState.push({ userId: id, lastReadAt: new Date() });
    }
  }
  conv.name = `${project.title} Workspace`;
  conv.projectId = project._id;
  await conv.save();
  return conv;
}

async function postWorkspaceStarterMessage(req, conversationId, senderId, text) {
  const message = await Message.create({
    conversationId,
    senderId,
    text,
  });

  const conversation = await Conversation.findById(conversationId);
  if (conversation) {
    conversation.lastMessageAt = message.createdAt || new Date();
    const senderState = (conversation.memberState || []).find((entry) => String(entry.userId) === String(senderId));
    if (senderState) {
      senderState.lastReadAt = conversation.lastMessageAt;
    }
    await conversation.save();
  }

  const io = req.app.get('io');
  if (io && conversation) {
    for (const participantId of conversation.participantIds || []) {
      if (String(participantId) === String(senderId)) continue;
      io.to(`user:${participantId}`).emit('message_notification', {
        conversationId: String(conversation._id),
        conversationType: 'group',
        title: 'Craft Hub',
        body: `${conversation.name || 'Workspace'}: ${text}`,
      });
      io.to(`user:${participantId}`).emit('project_workspace_ready', {
        projectId: String(conversation.projectId || ''),
        conversationId: String(conversation._id),
      });
    }
  }
}

async function autoCreateProjectWorkspace(req, projectOrId, { triggeredByUserId = null, requireOwnerRequest = false } = {}) {
  if (!githubConfigured()) {
    return { created: false, reason: 'not_configured' };
  }

  const project =
    typeof projectOrId === 'string' || projectOrId instanceof mongoose.Types.ObjectId
      ? await Project.findById(projectOrId)
      : projectOrId;
  if (!project) return { created: false, reason: 'project_missing' };

  if (project.workspace?.repoUrl) {
    return {
      created: false,
      reason: 'already_exists',
      project,
      conversationId: project.workspace.conversationId ? String(project.workspace.conversationId) : null,
    };
  }

  if (requireOwnerRequest && String(project.ownerId) !== String(triggeredByUserId)) {
    return { created: false, reason: 'owner_only', project };
  }

  if (projectMemberCount(project) > MAX_PROJECT_MEMBERS) {
    return { created: false, reason: 'too_many_collaborators', project };
  }

  const owner = await User.findById(project.ownerId).select(
    'name githubConnected githubUsername githubAccessToken'
  );
  if (!owner || !owner.githubConnected || !owner.githubAccessToken || !owner.githubUsername) {
    return { created: false, reason: 'owner_github_missing', project };
  }

  const collaboratorUsers = await User.find({
    _id: { $in: project.collaboratorIds || [] },
  }).select('name githubConnected githubUsername');

  if (!collaboratorUsers.length) {
    return { created: false, reason: 'no_collaborators', project };
  }

  const missingGithub = collaboratorUsers.filter((user) => !user.githubConnected || !user.githubUsername);
  if (missingGithub.length) {
    return {
      created: false,
      reason: 'collaborator_github_missing',
      project,
      missingUsers: missingGithub.map((user) => user.name),
    };
  }

  const workspaceMembers = await User.find({
    _id: {
      $in: [
        project.ownerId,
        ...(project.collaboratorIds || []),
      ],
    },
  }).select('name githubConnected githubUsername githubAccessToken');

  const triggeringMember = workspaceMembers.find((user) => String(user._id) === String(triggeredByUserId));
  const repoCreator =
    triggeringMember && triggeringMember.githubConnected && triggeringMember.githubAccessToken && triggeringMember.githubUsername
      ? triggeringMember
      : owner;

  const baseRepoName = project.workspace?.requestedRepoName || project.title;
  const repo = await createWorkspaceRepo(
    repoCreator.githubAccessToken,
    baseRepoName,
    project.description || `Collaborative workspace for ${project.title}`,
    project._id
  );

  for (const collaborator of workspaceMembers) {
    if (String(collaborator._id) === String(repoCreator._id)) continue;
    if (!collaborator.githubUsername) continue;
    await addGithubCollaborator(repoCreator.githubAccessToken, repo.owner.login, repo.name, collaborator.githubUsername);
    if (collaborator.githubAccessToken) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const invitations = await listUserRepoInvitations(collaborator.githubAccessToken);
        const match = (invitations || []).find((invitation) => {
          const repoInfo = invitation.repository || {};
          return (
            String(repoInfo.full_name || '').toLowerCase() === String(repo.full_name || '').toLowerCase()
          );
        });
        if (match?.id) {
          await acceptRepoInvitation(collaborator.githubAccessToken, match.id);
          break;
        }
        await delay(500);
      }
    }
  }

  const conversation = await ensureWorkspaceConversation(project);
  project.workspace = {
    provider: 'github',
    requestedRepoName: project.workspace?.requestedRepoName || '',
    repoOwner: String(repo.owner.login || ''),
    repoName: String(repo.name || slugRepoName(baseRepoName)),
    repoFullName: String(repo.full_name || `${repo.owner.login}/${repo.name}`),
    repoUrl: String(repo.html_url || ''),
    editorUrl: githubEditorUrl(String(repo.owner.login || ''), String(repo.name || slugRepoName(baseRepoName))),
    defaultBranch: String(repo.default_branch || 'main'),
    conversationId: conversation._id,
    createdByUserId: triggeredByUserId || project.ownerId,
    createdAt: new Date(),
    contributions: project.workspace?.contributions || [],
  };
  project.githubUrl = project.workspace.repoUrl;
  project.updatedAt = new Date();
  await project.save();

  await postWorkspaceStarterMessage(
    req,
    conversation._id,
    triggeredByUserId || project.ownerId,
    `GitHub workspace ready for "${project.title}". Repo: ${project.workspace.repoUrl} Editor: ${project.workspace.editorUrl}`
  );

  return {
    created: true,
    reason: 'created',
    project,
    conversationId: String(conversation._id),
  };
}

async function autoCreateEligibleWorkspacesForUser(req, userId) {
  if (!githubConfigured()) return [];

  const projects = await Project.find({
    $and: [
      {
        $or: [{ ownerId: userId }, { collaboratorIds: userId }],
      },
      {
        $or: [
          { 'workspace.repoUrl': { $exists: false } },
          { 'workspace.repoUrl': '' },
          { workspace: null },
        ],
      },
    ],
  });

  const created = [];
  for (const project of projects) {
    const result = await autoCreateProjectWorkspace(req, project, { triggeredByUserId: userId });
    if (result.created) {
      created.push({
        projectId: String(project._id),
        conversationId: result.conversationId || '',
      });
    }
  }
  return created;
}

module.exports = {
  autoCreateEligibleWorkspacesForUser,
  autoCreateProjectWorkspace,
};
