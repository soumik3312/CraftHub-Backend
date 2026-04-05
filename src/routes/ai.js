const express = require('express');

const Conversation = require('../models/Conversation');
const Project = require('../models/Project');
const User = require('../models/User');
const { PROJECT_GENRES } = require('../constants');
const { authRequired } = require('../middleware/auth');
const { publicUrl } = require('../utils/publicUrl');
const { toPublicUser } = require('../utils/toPublicUser');
const { aiStatus, aiChatJson, aiChatText } = require('../utils/aiProvider');

const router = express.Router();

function projectToPublic(req, project) {
  return {
    id: String(project._id),
    title: String(project.title || ''),
    description: String(project.description || ''),
    genres: (project.genres || []).map((entry) => String(entry)),
    techStack: (project.techStack || []).map((entry) => String(entry)),
    imageUrls: (project.imageUrls || []).map((value) => publicUrl(req, value)),
    ownerId: String(project.ownerId || ''),
    collaboratorCount: Array.isArray(project.collaboratorIds) ? project.collaboratorIds.length : 0,
    likeCount: Array.isArray(project.likeUserIds) ? project.likeUserIds.length : 0,
    commentCount: Array.isArray(project.comments) ? project.comments.length : 0,
    updatedAt: project.updatedAt || null,
  };
}

function safeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function appKnowledgeSummary() {
  return [
    'Craft Hub is a collaboration app for projects, posts, matching, chat, and GitHub-connected workspaces.',
    'Main areas: Home feed for posts, Projects feed for public projects, Match page for collaborator discovery, Messages for direct/workspace chats, Profile pages for users.',
    'Collaboration rules: collab requests are project-based, category overlap matters, and project collaboration unlocks chat/workspace.',
    'GitHub integration: users can connect GitHub, shared repos/workspaces can be created for collaboration projects, and Monaco workspace editing exists inside the app.',
    `Supported project genres include: ${PROJECT_GENRES.join(', ')}.`,
    'CraftBro should help with app guidance, collaboration flow, profiles, chat, GitHub workspace usage, and general project/coding guidance.',
  ].join('\n');
}

router.get('/status', authRequired, async (req, res) => {
  try {
    res.json(await aiStatus());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/match-scan', authRequired, async (req, res) => {
  try {
    const status = await aiStatus();
    if (!status.ready) {
      return res.status(503).json({ error: status.error || 'AI is not ready yet.' });
    }

    const domain = safeText(req.body.domain);
    if (!domain) {
      return res.status(400).json({ error: 'domain is required' });
    }

    const me = await User.findById(req.userId).select('name username bio genres');
    if (!me) return res.status(404).json({ error: 'User not found' });

    const users = await User.find({ _id: { $ne: req.userId } })
      .select('name username bio avatarUrl genres')
      .sort({ updatedAt: -1 })
      .limit(50);

    const projects = await Project.find({})
      .select('ownerId title description genres techStack imageUrls collaboratorIds likeUserIds comments updatedAt')
      .sort({ updatedAt: -1 })
      .limit(80);

    const ownerIds = [...new Set(projects.map((project) => String(project.ownerId)))];
    const owners = await User.find({ _id: { $in: ownerIds } }).select('name username avatarUrl');
    const ownerMap = new Map(owners.map((owner) => [String(owner._id), owner]));

    const userProjectRows = await Project.find({ ownerId: { $in: users.map((user) => user._id) } })
      .select('ownerId title genres techStack')
      .sort({ updatedAt: -1 })
      .limit(120);
    const projectMap = new Map();
    for (const row of userProjectRows) {
      const key = String(row.ownerId);
      if (!projectMap.has(key)) projectMap.set(key, []);
      projectMap.get(key).push({
        title: safeText(row.title),
        genres: (row.genres || []).map((entry) => String(entry)),
        techStack: (row.techStack || []).map((entry) => String(entry)),
      });
    }

    const prompt = {
      domain,
      currentUser: {
        id: String(me._id),
        name: safeText(me.name),
        username: safeText(me.username),
        bio: safeText(me.bio),
        genres: (me.genres || []).map((entry) => String(entry)),
      },
      candidateUsers: users.map((user) => ({
        id: String(user._id),
        name: safeText(user.name),
        username: safeText(user.username),
        bio: safeText(user.bio),
        genres: (user.genres || []).map((entry) => String(entry)),
        recentProjects: projectMap.get(String(user._id)) || [],
      })),
      candidateProjects: projects.map((project) => {
        const owner = ownerMap.get(String(project.ownerId));
        return {
          id: String(project._id),
          title: safeText(project.title),
          description: safeText(project.description),
          genres: (project.genres || []).map((entry) => String(entry)),
          techStack: (project.techStack || []).map((entry) => String(entry)),
          ownerName: safeText(owner?.name),
          ownerUsername: safeText(owner?.username),
          collaboratorCount: Array.isArray(project.collaboratorIds) ? project.collaboratorIds.length : 0,
        };
      }),
    };

    const result = await aiChatJson({
      system: [
        'You are Craft Hub Match AI.',
        'Scan the provided users and projects for the requested domain.',
        'Return only strict JSON with this shape:',
        '{"summary":"...", "users":[{"id":"...","matchPercent":91,"reason":"..."}], "projects":[{"id":"...","matchPercent":88,"reason":"..."}]}',
        'Choose the strongest collaboration matches only.',
        'Percentages must be realistic from 60 to 99.',
        'Reasons must be concise and specific to the requested domain, the profile, and the project data.',
      ].join('\n'),
      user: JSON.stringify(prompt),
      temperature: 0.2,
    });

    const userScoreMap = new Map((Array.isArray(result.users) ? result.users : []).map((entry) => [String(entry.id), entry]));
    const projectScoreMap = new Map((Array.isArray(result.projects) ? result.projects : []).map((entry) => [String(entry.id), entry]));

    const matchedUsers = users
      .map((user) => {
        const score = userScoreMap.get(String(user._id));
        if (!score) return null;
        return {
          ...toPublicUser(req, user),
          matchPercent: Number(score.matchPercent || 0),
          matchReason: safeText(score.reason),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.matchPercent - a.matchPercent)
      .slice(0, 8);

    const matchedProjects = projects
      .map((project) => {
        const score = projectScoreMap.get(String(project._id));
        if (!score) return null;
        return {
          ...projectToPublic(req, project),
          matchPercent: Number(score.matchPercent || 0),
          matchReason: safeText(score.reason),
        };
      })
      .filter(Boolean)
      .sort((a, b) => b.matchPercent - a.matchPercent)
      .slice(0, 8);

    res.json({
      provider: status.provider,
      model: status.model,
      domain,
      summary: safeText(result.summary, `AI scan completed for ${domain}.`),
      users: matchedUsers,
      projects: matchedProjects,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.post('/craftbro', authRequired, async (req, res) => {
  try {
    const status = await aiStatus();
    if (!status.ready) {
      return res.status(503).json({ error: status.error || 'AI is not ready yet.' });
    }

    const message = safeText(req.body.message);
    if (!message) return res.status(400).json({ error: 'message is required' });

    const history = Array.isArray(req.body.history)
      ? req.body.history
          .slice(-10)
          .map((entry) => ({
            role: entry?.role === 'assistant' ? 'assistant' : 'user',
            content: safeText(entry?.content),
          }))
          .filter((entry) => entry.content)
      : [];

    const user = await User.findById(req.userId).select('name username bio genres githubConnected githubUsername');
    const projectRows = await Project.find({
      $or: [{ ownerId: req.userId }, { collaboratorIds: req.userId }],
    })
      .select('title description genres techStack workspace')
      .sort({ updatedAt: -1 })
      .limit(10);
    const conversations = await Conversation.find({ participantIds: req.userId })
      .select('type name projectId')
      .sort({ lastMessageAt: -1 })
      .limit(10);

    const context = {
      user: user
        ? {
            name: safeText(user.name),
            username: safeText(user.username),
            bio: safeText(user.bio),
            genres: (user.genres || []).map((entry) => String(entry)),
            githubConnected: user.githubConnected === true,
            githubUsername: safeText(user.githubUsername),
          }
        : null,
      projects: projectRows.map((project) => ({
        title: safeText(project.title),
        description: safeText(project.description),
        genres: (project.genres || []).map((entry) => String(entry)),
        techStack: (project.techStack || []).map((entry) => String(entry)),
        hasWorkspace: Boolean(project.workspace?.repoUrl),
      })),
      conversations: conversations.map((conversation) => ({
        type: safeText(conversation.type),
        name: safeText(conversation.name, conversation.type === 'group' ? 'Workspace Chat' : 'Direct Chat'),
      })),
    };

    const reply = await aiChatText({
      system: [
        'You are CraftBro, the official Craft Hub assistant.',
        'Be friendly, concise, practical, and app-aware.',
        'Help users with app navigation, collaboration flow, GitHub workspace setup, profiles, matching, chat, projects, coding help, and troubleshooting.',
        'If the user asks how to do something in the app, answer with simple step-by-step instructions.',
        'If the user asks coding or project questions, help directly and tie examples to their project context when relevant.',
        appKnowledgeSummary(),
      ].join('\n\n'),
      history,
      user: JSON.stringify({
        context,
        question: message,
      }),
      temperature: 0.4,
    });

    res.json({
      provider: status.provider,
      model: status.model,
      reply,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
