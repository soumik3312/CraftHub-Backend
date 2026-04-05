const express = require('express');
const rateLimit = require('express-rate-limit');
const { authRequired } = require('../middleware/auth');
const { upload } = require('../multerUpload');
const authController = require('../controllers/authController');

const router = express.Router();

const strictLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const otpVerifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
});

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.post(
  '/register',
  strictLimiter,
  (req, res, next) => {
    req.uploadType = 'avatar';
    next();
  },
  upload.single('avatar'),
  wrap(authController.register)
);

router.post('/verify-register', otpVerifyLimiter, wrap(authController.verifyRegister));
router.post('/resend-register', strictLimiter, wrap(authController.resendRegister));
router.post('/login', strictLimiter, wrap(authController.login));
router.post('/verify-login', otpVerifyLimiter, wrap(authController.verifyLogin));
router.post('/resend-login', strictLimiter, wrap(authController.resendLogin));
router.get('/me', authRequired, wrap(authController.me));

module.exports = router;
