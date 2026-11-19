const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const Conversation = require('./models/Conversation');

dotenv.config();
const fallbackGithubEnvPath = path.join(__dirname, '..', '.env.github');
if (
  fs.existsSync(fallbackGithubEnvPath) &&
  (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET || !process.env.GITHUB_OAUTH_REDIRECT_URI)
) {
  dotenv.config({ path: fallbackGithubEnvPath });
}

const { connectDb, migrateLegacyEmailVerified } = require('./config/db');
const { verifyEmailProviderIfConfigured } = require('./utils/mailer');
const authRoutes = require('./routes/auth');
const usersRoutes = require('./routes/users');
const githubRoutes = require('./routes/github');
const projectsRoutes = require('./routes/projects');
const collabRoutes = require('./routes/collab');
const postsRoutes = require('./routes/posts');
const searchRoutes = require('./routes/search');
const conversationsRoutes = require('./routes/conversations');
const aiRoutes = require('./routes/ai');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

app.set('io', io);
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Unauthorized'));
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    socket.userId = String(payload.sub);
    next();
  } catch {
    next(new Error('Unauthorized'));
  }
});

io.on('connection', (socket) => {
  socket.join(`user:${socket.userId}`);
  socket.on('join', async (conversationId, acknowledge) => {
    if (!conversationId) return acknowledge?.({ ok: false, error: 'Conversation id required' });
    try {
      const conversation = await Conversation.exists({
        _id: conversationId,
        participantIds: socket.userId,
      });
      if (!conversation) return acknowledge?.({ ok: false, error: 'Forbidden' });
      socket.join(`conv:${conversationId}`);
      acknowledge?.({ ok: true });
    } catch {
      acknowledge?.({ ok: false, error: 'Invalid conversation' });
    }
  });
  socket.on('leave', (conversationId) => {
    if (!conversationId) return;
    socket.leave(`conv:${conversationId}`);
  });
});

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(
  cors({
    origin: true,
    credentials: true,
  })
);
app.use(express.json({ limit: '2mb' }));
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

const uploadRoot = path.join(__dirname, '..', 'uploads');
app.use('/uploads', express.static(uploadRoot));

app.get('/health', (req, res) => {
  // This reveals configuration presence only, never the client ID itself.
  // It lets deployment checks distinguish a missing Render variable from a
  // bad Google client/SHA configuration on the Android device.
  res.json({
    ok: true,
    service: 'craft-hub-api',
    googleAuthConfigured: Boolean(String(process.env.GOOGLE_WEB_CLIENT_ID || '').trim()),
  });
});

app.use('/api/auth', authRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/github', githubRoutes);
app.use('/api/projects', projectsRoutes);
app.use('/api/collab', collabRoutes);
app.use('/api/posts', postsRoutes);
app.use('/api/search', searchRoutes);
app.use('/api/conversations', conversationsRoutes);
app.use('/api/ai', aiRoutes);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(err.status || 500).json({
    error: err.message || 'Server error',
  });
});

const port = Number(process.env.PORT) || 3000;

connectDb()
  .then(() => migrateLegacyEmailVerified())
  .then(() => {
    server.listen(port, '0.0.0.0', () => {
      console.log(`Craft Hub API listening on http://0.0.0.0:${port}`);
      verifyEmailProviderIfConfigured().catch((e) => console.error('[email] verify error', e.message));
    });
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
