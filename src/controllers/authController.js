
const bcrypt = require('bcrypt');
const pool = require('../config/db');
const redis = require('../config/redis');
const {
  generateAccessToken,
  generateRefreshToken,
  verifyRefreshToken,
  hashToken,
} = require('../utils/tokens');
const {
  recordFailedAttempt,
  clearFailedAttempts,
} = require('../middleware/rateLimit');

const BCRYPT_ROUNDS = 12;
// WHY 12 rounds? Each round doubles the time.
// 10 rounds ≈ 65ms, 12 rounds ≈ 250ms, 14 rounds ≈ 1s.
// 12 is the industry sweet spot — slow enough to deter brute force,
// fast enough for real users.

// ─────────────────────────────────────────────
// POST /api/auth/register
// ─────────────────────────────────────────────

async function register(req, res) {
  const { email, password } = req.body;

  // Basic validation — in production you'd use Zod or Joi here
  if (!email || !password) {
    return res.status(400).json({ success: false, message: 'Email and password are required' });
  }

  if (typeof email !== 'string' || !email.includes('@')) {
    return res.status(400).json({ success: false, message: 'Invalid email format' });
  }

  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ success: false, message: 'Password must be at least 8 characters' });
  }

  try {
    // WHY: We check for duplicate email BEFORE hashing.
    // bcrypt takes ~250ms — checking first avoids wasting that time
    // on a request that will fail anyway.
    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
    if (existing.rows.length > 0) {
      // WHY: Return 409 Conflict, not 400.
      // 409 semantically means "this resource already exists".
      return res.status(409).json({ success: false, message: 'Email already registered' });
    }

    // Hash the password — bcrypt auto-generates a salt and embeds it in the hash
    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at',
      [email.toLowerCase(), passwordHash]
    );

    const user = result.rows[0];

    return res.status(201).json({
      success: true,
      message: 'User registered successfully',
      user: { id: user.id, email: user.email, createdAt: user.created_at },
    });
  } catch (err) {
    console.error('Register error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
}