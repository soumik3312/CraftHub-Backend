const mongoose = require('mongoose');

async function connectDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error('MONGODB_URI is missing. Copy backend/.env.example to backend/.env');
  }
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: Number(process.env.MONGODB_SERVER_SELECTION_MS || 12000),
    connectTimeoutMS: Number(process.env.MONGODB_CONNECT_MS || 12000),
  });
  console.log('MongoDB connected');
}

/** Accounts created before email OTP will not have emailVerified — treat them as verified. */
async function migrateLegacyEmailVerified() {
  const User = require('../models/User');
  const r = await User.updateMany({ emailVerified: { $exists: false } }, { $set: { emailVerified: true } });
  if (r.modifiedCount) {
    console.log(`Migration: set emailVerified=true on ${r.modifiedCount} existing user(s)`);
  }
}

module.exports = { connectDb, migrateLegacyEmailVerified };
