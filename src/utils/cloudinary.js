const { v2: cloudinary } = require('cloudinary');

const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || '')
  .trim()
  .toLowerCase();
const apiKey = String(process.env.CLOUDINARY_API_KEY || '').trim();
const apiSecret = String(process.env.CLOUDINARY_API_SECRET || '').trim();
const folderPrefix = String(
  process.env.CLOUDINARY_FOLDER_PREFIX || 'crafthub'
).trim().replace(/^\/+|\/+$/g, '');

if (cloudName && apiKey && apiSecret) {
  cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });
}

function cloudinaryConfigured() {
  return !!(cloudName && apiKey && apiSecret);
}

function ensureCloudinaryConfigured() {
  if (!cloudinaryConfigured()) {
    const error = new Error('Cloudinary storage is not configured on the server');
    error.status = 503;
    throw error;
  }
}

function folderFor(kind) {
  const normalized = String(kind || '').trim().replace(/^\/+|\/+$/g, '');
  return normalized ? `${folderPrefix}/${normalized}` : folderPrefix;
}

function uploadBuffer(
  file,
  { folder, resourceType = 'auto', publicId } = {}
) {
  ensureCloudinaryConfigured();
  if (!file?.buffer?.length) {
    throw new Error('Upload file buffer missing');
  }

  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder: folderFor(folder),
        resource_type: resourceType,
        public_id: publicId,
        use_filename: !publicId,
        unique_filename: !publicId,
        overwrite: false,
        filename_override: file.originalname || undefined,
      },
      (error, result) => {
        if (error) return reject(error);
        resolve({
          url: result.secure_url || result.url || '',
          publicId: result.public_id || '',
          resourceType: result.resource_type || resourceType,
          bytes: Number(result.bytes || 0),
          format: result.format || '',
          originalName: file.originalname || '',
        });
      }
    );

    stream.end(file.buffer);
  });
}

async function destroyAsset(publicId, resourceType = 'image') {
  if (!publicId || !cloudinaryConfigured()) return false;
  try {
    const result = await cloudinary.uploader.destroy(publicId, {
      resource_type: resourceType || 'image',
      invalidate: true,
    });
    return result?.result === 'ok' || result?.result === 'not found';
  } catch (error) {
    console.error('[cloudinary] Failed to delete asset:', publicId, error.message);
    return false;
  }
}

module.exports = {
  cloudinaryConfigured,
  destroyAsset,
  ensureCloudinaryConfigured,
  folderFor,
  uploadBuffer,
};
