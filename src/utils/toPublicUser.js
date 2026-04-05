const { publicUrl } = require('./publicUrl');
const { normalizeUserSettings } = require('./userSettings');

function toPublicUser(req, doc) {
  if (!doc) return null;
  const o = doc.toObject ? doc.toObject() : { ...doc };
  delete o.passwordHash;
  delete o.githubAccessToken;
  delete o.avatarPublicId;
  delete o.avatarResourceType;
  if (o.avatarUrl) o.avatarUrl = publicUrl(req, o.avatarUrl);
  o.githubConnected = o.githubConnected === true;
  o.githubUsername = o.githubUsername || '';
  o.githubProfileUrl = o.githubProfileUrl || '';
  o.settings = normalizeUserSettings(o.settings);
  o.id = String(o._id);
  delete o._id;
  delete o.__v;
  return o;
}

module.exports = { toPublicUser };
