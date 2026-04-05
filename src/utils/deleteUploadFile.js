const fs = require('fs/promises');
const path = require('path');
const { uploadRoot } = require('../multerUpload');

async function deleteUploadFile(uploadPath) {
  if (!uploadPath || typeof uploadPath !== 'string') return;

  const normalized = uploadPath.replace(/\\/g, '/');
  if (!normalized.startsWith('/uploads/')) return;

  const relativePath = normalized.slice('/uploads/'.length);
  const targetPath = path.resolve(uploadRoot, relativePath);
  const rootPath = path.resolve(uploadRoot);
  const rel = path.relative(rootPath, targetPath);

  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return;

  try {
    await fs.unlink(targetPath);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error('[uploads] Failed to delete file:', targetPath, err.message);
    }
  }
}

module.exports = { deleteUploadFile };
