const express = require('express');
const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Project = require('../models/Project');
const User = require('../models/User');
const { authRequired } = require('../middleware/auth');
const { toPublicUser } = require('../utils/toPublicUser');
const { ensureDirectConversation } = require('../utils/directConversation');

const router = express.Router();

function isParticipant(conv, userId) {
  return (conv.participantIds || []).some((id) => String(id) === String(userId));
}

function memberLastReadAt(conv, userId) {
  const state = (conv.memberState || []).find((entry) => String(entry.userId) === String(userId));
  return state?.lastReadAt || null;
}

function touchMemberRead(conv, userId, at = new Date()) {
  if (!Array.isArray(conv.memberState)) conv.memberState = [];
  const existing = conv.memberState.find((entry) => String(entry.userId) === String(userId));
  if (existing) {
    existing.lastReadAt = at;
    return;
  }
  conv.memberState.push({ userId, lastReadAt: at });
}

async function collaboratorContactIds(userId) {
  const user = await User.findById(userId).select('networkPartnerIds');
  const network = (user?.networkPartnerIds || []).map((id) => String(id));
  const shared = await Project.find({
    $or: [{ ownerId: userId }, { collaboratorIds: userId }],
  }).select('ownerId collaboratorIds');

  const out = new Set(network);
  const me = String(userId);
  for (const p of shared) {
    if (String(p.ownerId) !== me) out.add(String(p.ownerId));
    for (const c of p.collaboratorIds || []) {
      if (String(c) !== me) out.add(String(c));
    }
  }
  out.delete(me);
  return out;
}

function toPublicMessage(req, o) {
  const sender = o.senderId?._id ? toPublicUser(req, o.senderId) : null;
  const reply = o.replyToMessageId
    ? {
        id: String(o.replyToMessageId._id || o.replyToMessageId),
        text: o.replyToMessageId.text || '',
        sender: o.replyToMessageId.senderId?._id
          ? toPublicUser(req, o.replyToMessageId.senderId)
          : null,
      }
    : null;
  return {
    id: String(o._id),
    text: o.text,
    createdAt: o.createdAt,
    sender,
    replyTo: reply,
    reactions: (o.reactions || []).map((r) => ({
      userId: String(r.userId?._id || r.userId),
      emoji: r.emoji,
      user: r.userId?._id ? toPublicUser(req, r.userId) : null,
    })),
  };
}

router.get('/', authRequired, async (req, res) => {
  try {
    const contactIdSet = await collaboratorContactIds(req.userId);
    const contacts = await User.find({ _id: { $in: [...contactIdSet] } }).select(
      'name username avatarUrl bio genres'
    );
    const list = await Conversation.find({ participantIds: req.userId })
      .sort({ lastMessageAt: -1 })
      .limit(80);
    const out = [];
    let unreadMessages = 0;
    for (const c of list) {
      const others = await User.find({
        _id: { $in: c.participantIds.filter((id) => String(id) !== String(req.userId)) },
      }).select('name username avatarUrl');
      const lastMessage = await Message.findOne({ conversationId: c._id })
        .sort({ createdAt: -1 })
        .populate('senderId', 'name username avatarUrl');
      const readAt = memberLastReadAt(c, req.userId) || new Date(0);
      const unreadCount = await Message.countDocuments({
        conversationId: c._id,
        createdAt: { $gt: readAt },
        senderId: { $ne: req.userId },
      });
      unreadMessages += unreadCount;
      out.push({
        id: String(c._id),
        type: c.type,
        name: c.name || (others[0] ? others.map((u) => u.name).join(', ') : 'Chat'),
        projectId: c.projectId ? String(c.projectId) : null,
        lastMessageAt: c.lastMessageAt,
        lastMessageText: lastMessage?.text || '',
        lastMessageSender:
          lastMessage?.senderId?._id ? toPublicUser(req, lastMessage.senderId) : null,
        unreadCount,
        participants: (c.participantIds || []).map(String),
        otherUsers: others.map((u) => toPublicUser(req, u)),
      });
    }
    res.json({
      conversations: out,
      contacts: contacts.map((u) => toPublicUser(req, u)),
      summary: {
        unreadMessages,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/dm', authRequired, async (req, res) => {
  try {
    const otherId = req.body.userId;
    if (!otherId || String(otherId) === String(req.userId)) {
      return res.status(400).json({ error: 'userId required' });
    }
    const other = await User.findById(otherId);
    if (!other) return res.status(404).json({ error: 'User not found' });
    const contactIdSet = await collaboratorContactIds(req.userId);
    if (!contactIdSet.has(String(otherId))) {
      return res.status(403).json({ error: 'You can chat only with collaborators' });
    }

    const conv = await ensureDirectConversation(req.userId, otherId);
    res.status(201).json({ id: String(conv._id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/group', authRequired, async (req, res) => {
  try {
    const name = String(req.body.name || '').trim() || 'Group';
    const ids = Array.isArray(req.body.userIds) ? req.body.userIds.map(String) : [];
    const projectId = req.body.projectId || null;
    const contactIdSet = await collaboratorContactIds(req.userId);
    if (ids.some((id) => id !== String(req.userId) && !contactIdSet.has(String(id)))) {
      return res.status(403).json({ error: 'You can add only collaborators to a group chat' });
    }
    const set = new Set([...ids, String(req.userId)]);
    if (set.size < 2) return res.status(400).json({ error: 'Need at least 2 participants' });
    const participantIds = [...set].map((id) => new mongoose.Types.ObjectId(id));
    const conv = await Conversation.create({
      type: 'group',
      name,
      participantIds,
      memberState: participantIds.map((id) => ({ userId: id, lastReadAt: new Date() })),
      projectId: projectId ? new mongoose.Types.ObjectId(String(projectId)) : null,
      lastMessageAt: new Date(),
    });
    res.status(201).json({ id: String(conv._id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/messages', authRequired, async (req, res) => {
  try {
    const conv = await Conversation.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: 'Not found' });
    if (!isParticipant(conv, req.userId)) return res.status(403).json({ error: 'Forbidden' });
    touchMemberRead(conv, req.userId);
    await conv.save();
    const msgs = await Message.find({ conversationId: conv._id })
      .sort({ createdAt: 1 })
      .limit(200)
      .populate('senderId', 'name username avatarUrl')
      .populate('replyToMessageId', 'text senderId')
      .populate({ path: 'replyToMessageId', populate: { path: 'senderId', select: 'name username avatarUrl' } })
      .populate('reactions.userId', 'name username avatarUrl');
    res.json({
      messages: msgs.map((m) => toPublicMessage(req, m.toObject())),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/messages', authRequired, async (req, res) => {
  try {
    const conv = await Conversation.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: 'Not found' });
    if (!isParticipant(conv, req.userId)) return res.status(403).json({ error: 'Forbidden' });
    const text = String(req.body.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    let replyToMessageId = null;
    if (req.body.replyToMessageId) {
      const maybe = await Message.findOne({
        _id: req.body.replyToMessageId,
        conversationId: conv._id,
      }).select('_id');
      if (maybe) replyToMessageId = maybe._id;
    }
    const msg = await Message.create({
      conversationId: conv._id,
      senderId: req.userId,
      text,
      replyToMessageId,
    });
    conv.lastMessageAt = msg.createdAt || new Date();
    touchMemberRead(conv, req.userId, conv.lastMessageAt);
    await conv.save();
    const populated = await Message.findById(msg._id)
      .populate('senderId', 'name username avatarUrl')
      .populate('replyToMessageId', 'text senderId')
      .populate({ path: 'replyToMessageId', populate: { path: 'senderId', select: 'name username avatarUrl' } })
      .populate('reactions.userId', 'name username avatarUrl');
    const o = populated.toObject();
    const payload = {
      ...toPublicMessage(req, o),
      conversationId: String(conv._id),
    };
    const io = req.app.get('io');
    if (io) {
      io.to(`conv:${conv._id}`).emit('message', payload);
      const conversationName = String(
        conv.name || (conv.type === 'group' ? 'Workspace' : 'Direct inbox')
      ).trim();
      const senderName = String(o.sender?.name || 'Someone').trim() || 'Someone';
      for (const participantId of conv.participantIds || []) {
        if (String(participantId) === String(req.userId)) continue;
        io.to(`user:${participantId}`).emit('message_notification', {
          conversationId: String(conv._id),
          conversationType: conv.type,
          title: 'Craft Hub',
          body:
            conv.type === 'group'
              ? `${conversationName}: ${senderName}: ${text}`
              : `${senderName}: ${text}`,
        });
      }
    }
    res.status(201).json({ message: payload });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/messages/:messageId/react', authRequired, async (req, res) => {
  try {
    const conv = await Conversation.findById(req.params.id);
    if (!conv) return res.status(404).json({ error: 'Not found' });
    if (!isParticipant(conv, req.userId)) return res.status(403).json({ error: 'Forbidden' });
    const emoji = String(req.body.emoji || '').trim();
    if (!emoji) return res.status(400).json({ error: 'emoji required' });

    const msg = await Message.findOne({ _id: req.params.messageId, conversationId: conv._id });
    if (!msg) return res.status(404).json({ error: 'Message not found' });

    const me = String(req.userId);
    const existing = (msg.reactions || []).find((r) => String(r.userId) === me);
    // Toggle behavior:
    // - same emoji tap => unreact (remove)
    // - different/new emoji => set/replace reaction
    if (existing && existing.emoji === emoji) {
      msg.reactions = (msg.reactions || []).filter((r) => String(r.userId) !== me);
    } else {
      msg.reactions = (msg.reactions || []).filter((r) => String(r.userId) !== me);
      msg.reactions.push({ userId: req.userId, emoji });
    }
    await msg.save();

    const populated = await Message.findById(msg._id)
      .populate('senderId', 'name username avatarUrl')
      .populate('replyToMessageId', 'text senderId')
      .populate({ path: 'replyToMessageId', populate: { path: 'senderId', select: 'name username avatarUrl' } })
      .populate('reactions.userId', 'name username avatarUrl');
    const payload = {
      ...toPublicMessage(req, populated.toObject()),
      conversationId: String(conv._id),
    };
    const io = req.app.get('io');
    if (io) {
      io.to(`conv:${conv._id}`).emit('message_reaction', payload);
    }
    res.json({ message: payload });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
