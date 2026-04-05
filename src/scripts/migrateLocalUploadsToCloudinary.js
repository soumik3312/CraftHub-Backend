const fs = require('fs/promises');
const path = require('path');
const dotenv = require('dotenv');
const mongoose = require('mongoose');

dotenv.config();

const { connectDb } = require('../config/db');
const { uploadRoot } = require('../multerUpload');
const { ensureCloudinaryConfigured, uploadBuffer } = require('../utils/cloudinary');
const { deleteStoredAsset } = require('../utils/deleteStoredAsset');
const User = require('../models/User');
const Post = require('../models/Post');
const Project = require('../models/Project');

function isLocalUpload(value) {
  return typeof value === 'string' && value.replace(/\\/g, '/').startsWith('/uploads/');
}

function uploadPathToAbsolute(uploadPath) {
  const normalized = uploadPath.replace(/\\/g, '/');
  const relativePath = normalized.slice('/uploads/'.length);
  return path.resolve(uploadRoot, relativePath);
}

async function readLegacyFile(uploadPath) {
  const absolutePath = uploadPathToAbsolute(uploadPath);
  const buffer = await fs.readFile(absolutePath);
  return {
    buffer,
    originalname: path.basename(absolutePath),
  };
}

async function migrateUserAvatars() {
  const users = await User.find({
    avatarUrl: { $exists: true, $ne: '' },
  }).select('avatarUrl avatarPublicId avatarResourceType');

  let migrated = 0;
  for (const user of users) {
    if (!isLocalUpload(user.avatarUrl)) continue;
    const file = await readLegacyFile(user.avatarUrl);
    const asset = await uploadBuffer(file, {
      folder: 'avatars',
      resourceType: 'image',
    });
    const oldAvatarUrl = user.avatarUrl;
    user.avatarUrl = asset.url;
    user.avatarPublicId = asset.publicId;
    user.avatarResourceType = asset.resourceType;
    await user.save();
    await deleteStoredAsset(oldAvatarUrl);
    migrated += 1;
    console.log(`[migrate] user avatar ${user._id}`);
  }
  return migrated;
}

async function migratePostImages() {
  const posts = await Post.find({
    imageUrls: { $exists: true, $ne: [] },
  }).select('imageUrls imagePublicIds imageResourceTypes');

  let migrated = 0;
  for (const post of posts) {
    let changed = false;
    const nextUrls = [];
    const nextPublicIds = [];
    const nextResourceTypes = [];

    for (let i = 0; i < (post.imageUrls || []).length; i += 1) {
      const url = post.imageUrls[i];
      if (isLocalUpload(url)) {
        const file = await readLegacyFile(url);
        const asset = await uploadBuffer(file, {
          folder: 'posts',
          resourceType: 'image',
        });
        nextUrls.push(asset.url);
        nextPublicIds.push(asset.publicId);
        nextResourceTypes.push(asset.resourceType);
        await deleteStoredAsset(url);
        changed = true;
      } else {
        nextUrls.push(url);
        nextPublicIds.push((post.imagePublicIds || [])[i] || '');
        nextResourceTypes.push((post.imageResourceTypes || [])[i] || 'image');
      }
    }

    if (!changed) continue;
    post.imageUrls = nextUrls;
    post.imagePublicIds = nextPublicIds;
    post.imageResourceTypes = nextResourceTypes;
    await post.save();
    migrated += 1;
    console.log(`[migrate] post images ${post._id}`);
  }
  return migrated;
}

async function migrateProjectMedia() {
  const projects = await Project.find({}).select(
    'imageUrls imagePublicIds imageResourceTypes sourceFile'
  );

  let migrated = 0;
  for (const project of projects) {
    let changed = false;
    const nextUrls = [];
    const nextPublicIds = [];
    const nextResourceTypes = [];

    for (let i = 0; i < (project.imageUrls || []).length; i += 1) {
      const url = project.imageUrls[i];
      if (isLocalUpload(url)) {
        const file = await readLegacyFile(url);
        const asset = await uploadBuffer(file, {
          folder: 'projects/images',
          resourceType: 'image',
        });
        nextUrls.push(asset.url);
        nextPublicIds.push(asset.publicId);
        nextResourceTypes.push(asset.resourceType);
        await deleteStoredAsset(url);
        changed = true;
      } else {
        nextUrls.push(url);
        nextPublicIds.push((project.imagePublicIds || [])[i] || '');
        nextResourceTypes.push(
          (project.imageResourceTypes || [])[i] || 'image'
        );
      }
    }

    project.imageUrls = nextUrls;
    project.imagePublicIds = nextPublicIds;
    project.imageResourceTypes = nextResourceTypes;

    if (isLocalUpload(project.sourceFile?.url || '')) {
      const file = await readLegacyFile(project.sourceFile.url);
      const asset = await uploadBuffer(file, {
        folder: 'projects/source',
        resourceType: 'raw',
      });
      const oldSourceUrl = project.sourceFile.url;
      project.sourceFile = {
        ...project.sourceFile,
        url: asset.url,
        publicId: asset.publicId,
        resourceType: asset.resourceType,
      };
      await deleteStoredAsset(oldSourceUrl);
      changed = true;
    }

    if (!changed) continue;
    await project.save();
    migrated += 1;
    console.log(`[migrate] project media ${project._id}`);
  }
  return migrated;
}

async function run() {
  ensureCloudinaryConfigured();
  await connectDb();

  try {
    const avatars = await migrateUserAvatars();
    const posts = await migratePostImages();
    const projects = await migrateProjectMedia();
    console.log(
      `[migrate] done avatars=${avatars} posts=${posts} projects=${projects}`
    );
  } finally {
    await mongoose.connection.close();
  }
}

run().catch((error) => {
  console.error('[migrate] failed:', error.message);
  process.exit(1);
});
