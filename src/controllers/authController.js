// Auth Controller
// - register: hash password, save user to DB, return tokens
// - login: verify credentials, return access + refresh tokens
// - logout: blacklist the token in Redis
// - refresh: validate refresh token, issue new access token
const bcrypt = require('bcrypt');
const pool = require('../config/db');
const redis = require('../config/redis');

const {generateAccessToken, generateRefreshToken, hashToken, verifyRefreshToken} = require('../utils/tokens');

// cons

const BCRYPT_ROUNDS = 12;
// WHY 12 rounds? Each round doubles the time.
// 10 rounds ≈ 65ms, 12 rounds ≈ 250ms, 14 rounds ≈ 1s.
// 12 is the industry sweet spot — slow enough to deter brute force,
// fast enough for real users.

async function register()