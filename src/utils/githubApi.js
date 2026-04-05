const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_AUTH_BASE = 'https://github.com';
const GITHUB_API_VERSION = '2022-11-28';
const OAUTH_COMPLETE_PATH = '/api/github/oauth/complete';

function githubConfigured() {
  return Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
}

function publicBaseUrl(req) {
  return (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
}

function githubRedirectUri(req) {
  return (process.env.GITHUB_OAUTH_REDIRECT_URI || `${publicBaseUrl(req)}/api/github/oauth/callback`).replace(/\/$/, '');
}

function githubCompleteUrl(req, status, message = '') {
  const url = new URL(`${publicBaseUrl(req)}${OAUTH_COMPLETE_PATH}`);
  url.searchParams.set('status', status);
  if (message) url.searchParams.set('message', message);
  return url.toString();
}

function githubAuthorizeUrl({ req, state }) {
  const url = new URL(`${GITHUB_AUTH_BASE}/login/oauth/authorize`);
  url.searchParams.set('client_id', process.env.GITHUB_CLIENT_ID || '');
  url.searchParams.set('redirect_uri', githubRedirectUri(req));
  url.searchParams.set('scope', 'repo read:user');
  url.searchParams.set('state', state);
  url.searchParams.set('allow_signup', 'true');
  url.searchParams.set('prompt', 'select_account');
  return url.toString();
}

async function parseResponseBody(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

async function githubRequest(path, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${GITHUB_API_BASE}${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'craft-hub-api',
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await parseResponseBody(response);
  if (!response.ok) {
    const message =
      payload.message ||
      (Array.isArray(payload.errors) && payload.errors.length
        ? payload.errors.map((entry) => entry.message || entry.code || 'GitHub error').join(', ')
        : 'GitHub request failed');
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

async function exchangeGithubCode(req, code) {
  const response = await fetch(`${GITHUB_AUTH_BASE}/login/oauth/access_token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'User-Agent': 'craft-hub-api',
    },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID,
      client_secret: process.env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: githubRedirectUri(req),
    }),
  });

  const payload = await parseResponseBody(response);
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || 'GitHub OAuth exchange failed');
  }
  return payload.access_token;
}

async function fetchGithubUser(token) {
  return githubRequest('/user', { token });
}

async function fetchGithubUserRepos(token, { perPage = 6 } = {}) {
  return githubRequest(`/user/repos?sort=updated&direction=desc&per_page=${encodeURIComponent(String(perPage))}`, {
    token,
  });
}

async function fetchGithubUserEvents(token, username, { perPage = 50 } = {}) {
  return githubRequest(
    `/users/${encodeURIComponent(username)}/events?per_page=${encodeURIComponent(String(perPage))}`,
    { token }
  );
}

async function createGithubRepo(token, repoName, description) {
  return githubRequest('/user/repos', {
    method: 'POST',
    token,
    body: {
      name: repoName,
      description: description || '',
      private: true,
      auto_init: true,
      has_issues: true,
      has_projects: false,
      has_wiki: false,
    },
  });
}

async function addGithubCollaborator(token, owner, repo, username) {
  return githubRequest(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators/${encodeURIComponent(username)}`, {
    method: 'PUT',
    token,
    body: {
      permission: 'push',
    },
  });
}

async function listUserRepoInvitations(token) {
  return githubRequest('/user/repository_invitations', { token });
}

async function acceptRepoInvitation(token, invitationId) {
  return githubRequest(`/user/repository_invitations/${encodeURIComponent(String(invitationId))}`, {
    method: 'PATCH',
    token,
  });
}

function githubRepoUrl(owner, repo) {
  return `https://github.com/${owner}/${repo}`;
}

function githubEditorUrl(owner, repo) {
  return `https://github.dev/${owner}/${repo}`;
}

function slugRepoName(value, fallback = 'craft-hub-project') {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 45);
  return slug || fallback;
}

module.exports = {
  acceptRepoInvitation,
  addGithubCollaborator,
  createGithubRepo,
  exchangeGithubCode,
  fetchGithubUser,
  fetchGithubUserEvents,
  fetchGithubUserRepos,
  githubAuthorizeUrl,
  githubCompleteUrl,
  githubConfigured,
  githubEditorUrl,
  githubRepoUrl,
  githubRequest,
  listUserRepoInvitations,
  slugRepoName,
};
