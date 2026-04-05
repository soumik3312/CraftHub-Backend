const express = require('express');
const jwt = require('jsonwebtoken');

const User = require('../models/User');
const { authRequired } = require('../middleware/auth');
const { toPublicUser } = require('../utils/toPublicUser');
const { autoCreateEligibleWorkspacesForUser } = require('../utils/projectWorkspace');
const {
  exchangeGithubCode,
  fetchGithubUser,
  fetchGithubUserEvents,
  fetchGithubUserRepos,
  githubAuthorizeUrl,
  githubCompleteUrl,
  githubConfigured,
} = require('../utils/githubApi');

const router = express.Router();

function signGithubState(userId) {
  return jwt.sign(
    {
      sub: String(userId),
      purpose: 'github-connect',
    },
    process.env.JWT_SECRET,
    { expiresIn: '15m' }
  );
}

function verifyGithubState(token) {
  const payload = jwt.verify(token, process.env.JWT_SECRET);
  if (payload?.purpose !== 'github-connect') {
    throw new Error('Invalid GitHub OAuth state');
  }
  return payload;
}

function oauthCompletePage(status, message) {
  const safeStatus = status === 'success' ? 'success' : 'error';
  const safeMessage = String(message || (safeStatus === 'success' ? 'GitHub account connected.' : 'GitHub connection failed.'));
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Craft Hub GitHub</title>
    <style>
      body { font-family: Arial, sans-serif; background: #111; color: #fff; margin: 0; display: grid; place-items: center; min-height: 100vh; }
      .card { max-width: 420px; padding: 24px; border-radius: 18px; background: #1c1c1c; border: 1px solid #333; text-align: center; }
      h1 { margin: 0 0 12px; font-size: 22px; }
      p { margin: 0; line-height: 1.5; color: #ddd; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${safeStatus === 'success' ? 'GitHub connected' : 'GitHub connection failed'}</h1>
      <p>${safeMessage}</p>
    </div>
  </body>
</html>`;
}

function githubDateKey(value) {
  return new Date(value).toISOString().slice(0, 10);
}

function buildContributionSeries(pushEvents) {
  const totals = new Map();
  for (const event of pushEvents) {
    const count = Math.max(1, (event.payload?.commits || []).length || 0);
    const key = githubDateKey(event.created_at);
    totals.set(key, (totals.get(key) || 0) + count);
  }

  const days = [];
  const now = new Date();
  for (let index = 41; index >= 0; index -= 1) {
    const day = new Date(now);
    day.setDate(now.getDate() - index);
    const key = githubDateKey(day);
    days.push({
      date: key,
      count: totals.get(key) || 0,
    });
  }
  return days;
}

async function buildGithubActivityPayload(user) {
  const [reposRaw, eventsRaw] = await Promise.all([
    fetchGithubUserRepos(user.githubAccessToken, { perPage: 6 }),
    fetchGithubUserEvents(user.githubAccessToken, user.githubUsername, { perPage: 50 }),
  ]);

  const repos = Array.isArray(reposRaw) ? reposRaw : [];
  const events = Array.isArray(eventsRaw) ? eventsRaw : [];
  const pushEvents = events.filter((event) => event?.type === 'PushEvent');
  const contributionSeries = buildContributionSeries(pushEvents);
  const recentCommits = pushEvents.slice(0, 8).map((event) => ({
    id: String(event.id || ''),
    repoFullName: String(event.repo?.name || ''),
    repoName: String(event.repo?.name || '').split('/').pop() || '',
    commitCount: Math.max(1, (event.payload?.commits || []).length || 0),
    messages: (event.payload?.commits || [])
      .slice(0, 3)
      .map((commit) => String(commit.message || '').trim())
      .filter(Boolean),
    createdAt: event.created_at || null,
  }));

  const totalRecentCommits = pushEvents.reduce((sum, event) => {
    return sum + Math.max(1, (event.payload?.commits || []).length || 0);
  }, 0);

  return {
    connected: true,
    username: user.githubUsername,
    profileUrl: user.githubProfileUrl || '',
    totalRecentCommits,
    contributionSeries,
    recentCommits,
    repositories: repos.slice(0, 4).map((repo) => ({
      id: String(repo.id || ''),
      name: String(repo.name || ''),
      fullName: String(repo.full_name || ''),
      description: String(repo.description || ''),
      language: String(repo.language || ''),
      stars: Number(repo.stargazers_count || 0),
      forks: Number(repo.forks_count || 0),
      updatedAt: repo.updated_at || null,
      htmlUrl: String(repo.html_url || ''),
    })),
  };
}

router.get('/status', authRequired, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-passwordHash');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
      configured: githubConfigured(),
      user: toPublicUser(req, user),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/activity', authRequired, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select(
      'githubConnected githubUsername githubAccessToken'
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.githubConnected || !user.githubUsername || !user.githubAccessToken) {
      return res.status(409).json({ error: 'Connect GitHub first to load commit activity.' });
    }

    res.json(await buildGithubActivityPayload(user));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/activity/user/:userId', authRequired, async (req, res) => {
  try {
    const user = await User.findById(req.params.userId).select(
      'githubConnected githubUsername githubProfileUrl githubAccessToken'
    );
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.githubConnected || !user.githubUsername || !user.githubAccessToken) {
      return res.status(404).json({ error: 'GitHub activity is not available for this user.' });
    }

    res.json(await buildGithubActivityPayload(user));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/connect/start', authRequired, async (req, res) => {
  try {
    if (!githubConfigured()) {
      return res.status(503).json({
        error: 'GitHub integration is not configured on the server',
      });
    }
    const state = signGithubState(req.userId);
    res.json({
      authorizeUrl: githubAuthorizeUrl({ req, state }),
      completeUrl: githubCompleteUrl(req, 'success').split('?')[0],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/oauth/callback', async (req, res) => {
  try {
    if (!githubConfigured()) {
      return res.redirect(githubCompleteUrl(req, 'error', 'GitHub integration is not configured on the server.'));
    }

    const code = String(req.query.code || '').trim();
    const state = String(req.query.state || '').trim();
    if (!code || !state) {
      return res.redirect(githubCompleteUrl(req, 'error', 'GitHub did not return the required OAuth data.'));
    }

    const payload = verifyGithubState(state);
    const accessToken = await exchangeGithubCode(req, code);
    const githubUser = await fetchGithubUser(accessToken);

    const user = await User.findById(payload.sub);
    if (!user) {
      return res.redirect(githubCompleteUrl(req, 'error', 'The Craft Hub user could not be found.'));
    }

    user.githubConnected = true;
    user.githubId = String(githubUser.id || '');
    user.githubUsername = String(githubUser.login || '');
    user.githubProfileUrl = String(githubUser.html_url || '');
    user.githubAccessToken = accessToken;
    await user.save();

    const created = await autoCreateEligibleWorkspacesForUser(req, user._id);
    const message = created.length
      ? `Connected as ${user.githubUsername || 'GitHub user'}. Workspace auto-created for ${created.length} project${created.length == 1 ? '' : 's'}.`
      : `Connected as ${user.githubUsername || 'GitHub user'}.`;

    return res.redirect(githubCompleteUrl(req, 'success', message));
  } catch (e) {
    return res.redirect(githubCompleteUrl(req, 'error', e.message || 'GitHub connection failed.'));
  }
});

router.get('/oauth/complete', (req, res) => {
  const status = String(req.query.status || '');
  const message = String(req.query.message || '');
  res.type('html').send(oauthCompletePage(status, message));
});

router.post('/disconnect', authRequired, async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.githubConnected = false;
    user.githubId = '';
    user.githubUsername = '';
    user.githubProfileUrl = '';
    user.githubAccessToken = '';
    await user.save();

    res.json({ ok: true, user: toPublicUser(req, user) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
