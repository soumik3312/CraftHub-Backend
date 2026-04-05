const path = require('path');
const multer = require('multer');

const uploadRoot = path.join(__dirname, '..', 'uploads');
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
});

module.exports = { upload, uploadRoot };
