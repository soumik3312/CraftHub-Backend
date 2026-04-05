function publicUrl(req, relativePath) {
  if (!relativePath) return '';
  if (relativePath.startsWith('http')) return relativePath;
  const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
  return `${base.replace(/\/$/, '')}${relativePath.startsWith('/') ? '' : '/'}${relativePath}`;
}

module.exports = { publicUrl };
