// WHY: We NEVER store the raw refresh token in Redis.
// If Redis is compromised, hashed tokens are useless to an attacker.
// We store SHA-256(refreshToken) and compare hashes on each request.
// This is the same principle as storing password hashes instead of passwords.

const { sign, verify } = require('jsonwebtoken');
const { createHash } = require('crypto');

/**
 * Generate a signed access token (short-lived, stateless)
 * The payload is minimal — only what you need. Never put sensitive data in JWTs.
 * JWTs are base64-encoded, NOT encrypted — anyone can decode the payload.
 */
function generateAccessToken(userId) {
  return sign(
    { sub: userId },  // 'sub' is the JWT standard claim for subject
    process.env.ACCESS_TOKEN_SECRET,
    {
      expiresIn: process.env.ACCESS_TOKEN_EXPIRY, // '15m'
      issuer: 'jwt-auth-api',                     // helps detect token misuse across services
    }
  );
}

/**
 * Generate a signed refresh token (long-lived, stateful in Redis)
 */
function generateRefreshToken(userId) {
  return sign(
    { sub: userId },
    process.env.REFRESH_TOKEN_SECRET,
    {
      expiresIn: process.env.REFRESH_TOKEN_EXPIRY, // '7d'
      issuer: 'jwt-auth-api',
    }
  );
}

/**
 * Verify an access token. Returns the decoded payload or throws.
 * We call this in the auth middleware on every protected request.
 */
function verifyAccessToken(token) {
  return verify(token, process.env.ACCESS_TOKEN_SECRET, {
    issuer: 'jwt-auth-api',
  });
}

/**
 * Verify a refresh token. Returns the decoded payload or throws.
 */
function verifyRefreshToken(token) {
  return verify(token, process.env.REFRESH_TOKEN_SECRET, {
    issuer: 'jwt-auth-api',
  });
}

/**
 * Hash a token using SHA-256.
 * WHY SHA-256 and not bcrypt? Because bcrypt is intentionally slow (for passwords).
 * Token comparison needs to be fast — we do it on every /refresh call.
 * SHA-256 is cryptographically strong enough for this purpose.
 */
function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

module.exports = {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  hashToken,
};