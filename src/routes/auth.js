const { Router } = require('express');
const { register, login, refresh, logout, me } = require('../controllers/authController');
const { authenticate } = require('../middleware/auth');
const { loginRateLimit } = require('../middleware/rateLimit');

const router = Router();

router.post('/register', register);
router.post('/login', loginRateLimit, login);  // Rate limiter runs BEFORE login handler
router.post('/refresh', refresh);
router.post('/logout', logout);
router.get('/me', authenticate, me);  // authenticate runs BEFORE me handler

module.exports = router;