const NOTIFICATION_DEFAULTS = Object.freeze({
  enabled: true,
  directMessages: true,
  workspaceMessages: true,
});

const DEFAULT_USER_SETTINGS = Object.freeze({
  themeMode: 'system',
  notifications: NOTIFICATION_DEFAULTS,
});

function normalizeThemeMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw === 'light' || raw === 'dark' ? raw : 'system';
}

function normalizeNotifications(input = {}) {
  const source =
    input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    enabled: source.enabled !== false,
    directMessages: source.directMessages !== false,
    workspaceMessages: source.workspaceMessages !== false,
  };
}

function normalizeUserSettings(input = {}) {
  const source =
    input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return {
    themeMode: normalizeThemeMode(source.themeMode),
    notifications: normalizeNotifications(source.notifications),
  };
}

module.exports = {
  DEFAULT_USER_SETTINGS,
  NOTIFICATION_DEFAULTS,
  normalizeNotifications,
  normalizeThemeMode,
  normalizeUserSettings,
};
