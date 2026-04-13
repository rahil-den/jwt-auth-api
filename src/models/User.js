const pool = require('../config/db');

// ─────────────────────────────────────────────
// User Model
// WHY: Keeping all SQL queries in one place makes them easy to find,
// test, and swap out (e.g. if you move from raw SQL to an ORM later).
// Controllers should NOT contain raw SQL — that's the model's job.
// ─────────────────────────────────────────────

const User = {
  /**
   * Find a user by their email address.
   * Returns the full row (including password_hash) — only use this for auth checks.
   */
  async findByEmail(email) {
    const result = await pool.query(
      'SELECT id, email, password_hash, created_at FROM users WHERE email = $1',
      [email.toLowerCase()]
    );
    return result.rows[0] || null;
  },

  /**
   * Find a user by their ID.
   * Returns safe fields only (no password_hash).
   */
  async findById(id) {
    const result = await pool.query(
      'SELECT id, email, created_at FROM users WHERE id = $1',
      [id]
    );
    return result.rows[0] || null;
  },

  /**
   * Create a new user with an already-hashed password.
   * Returns the newly created user (safe fields only).
   */
  async create(email, passwordHash) {
    const result = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email, created_at',
      [email.toLowerCase(), passwordHash]
    );
    return result.rows[0];
  },

  /**
   * Check whether an email is already taken.
   * Useful for pre-validation before doing the heavier bcrypt hash.
   */
  async emailExists(email) {
    const result = await pool.query(
      'SELECT 1 FROM users WHERE email = $1',
      [email.toLowerCase()]
    );
    return result.rows.length > 0;
  },
};

module.exports = User;
