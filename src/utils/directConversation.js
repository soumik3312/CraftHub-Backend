const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');

async function ensureDirectConversation(userAId, userBId) {
  const a = new mongoose.Types.ObjectId(String(userAId));
  const b = new mongoose.Types.ObjectId(String(userBId));

  let conversation = await Conversation.findOne({
    type: 'dm',
    participantIds: { $all: [a, b] },
    $expr: { $eq: [{ $size: '$participantIds' }, 2] },
  });

  if (!conversation) {
    const now = new Date();
    conversation = await Conversation.create({
      type: 'dm',
      participantIds: [a, b],
      memberState: [
        { userId: a, lastReadAt: now },
        { userId: b, lastReadAt: now },
      ],
      lastMessageAt: now,
    });
  }

  return conversation;
}

module.exports = { ensureDirectConversation };
