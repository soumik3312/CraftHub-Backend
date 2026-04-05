const fs = require('fs/promises');
const path = require('path');

const { uploadRoot } = require('../multerUpload');
const { destroyAsset } = require('./cloudinary');

async function deleteLegacyUpload(uploadPath) {
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

async function deleteStoredAsset(input) {
  if (!input) return;

  if (typeof input === 'string') {
    await deleteLegacyUpload(input);
    return;
  }

  const url = input.url || '';
  const publicId = input.publicId || '';
  const resourceType = input.resourceType || 'image';

  if (publicId) {
    await destroyAsset(publicId, resourceType);
    return;
  }

  await deleteLegacyUpload(url);
}

module.exports = { deleteStoredAsset };
