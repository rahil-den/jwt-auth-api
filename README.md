# JWT Auth API — Week 1

> A production-grade stateless-auth + stateful-refresh system built with Express, PostgreSQL, Redis, and JWT.
> This is the exact pattern used by companies like Razorpay and Groww.

---

## What We're Building

A **stateless access token + stateful refresh token** auth system where:

- **Access tokens** are short-lived JWTs verified with pure crypto — zero DB hits on protected routes
- **Refresh tokens** are long-lived JWTs whose **SHA-256 hashes** are stored in Redis — enabling token rotation and reuse detection
- **Rate limiting** is Redis-backed — works correctly across multiple Node.js processes

---

## Architecture Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         JWT AUTH FLOW                                   │
└─────────────────────────────────────────────────────────────────────────┘

  CLIENT                        SERVER                        STORES
  ──────                        ──────                        ──────

  POST /register ──────────────► Validate input
                                 Check duplicate email ──────► PostgreSQL
                                 bcrypt.hash(password, 12)
                                 INSERT user ────────────────► PostgreSQL
                ◄────────────── 201 { user }


  POST /login ─────────────────► loginRateLimit middleware
                                   redis.get(login_attempts:ip) ──► Redis
                                 SELECT user by email ──────────► PostgreSQL
                                 bcrypt.compare()  ← always runs (timing safety)
                                 generateAccessToken(userId)
                                 generateRefreshToken(userId)
                                 redis.setex(rt:<userId>, SHA256(refreshToken)) ► Redis
                ◄────────────── 200 { accessToken, refreshToken }


  GET /me ──────────────────────► authenticate middleware
  Authorization:                   Extract Bearer token
  Bearer <accessToken>             jwt.verify(token)  ← no DB call
                                   req.userId = decoded.sub
                                 SELECT user by id ─────────────► PostgreSQL
                ◄────────────── 200 { user }


  POST /refresh ───────────────► verifyRefreshToken(token)
  { refreshToken }                redis.get(rt:<userId>) ────────► Redis
                                  Compare SHA256(token) vs stored hash
                                  ┌─ MATCH ──────────────────────────────┐
                                  │  generateAccessToken()               │
                                  │  generateRefreshToken()              │
                                  │  redis.setex(rt:<userId>, newHash) ──►Redis
                                  │  return { newAccessToken,            │
                ◄─────────────────┘           newRefreshToken }          │
                                  └─ MISMATCH (REUSE DETECTED) ──────────┘
                                     redis.del(rt:<userId>)  ────────────►Redis
                ◄────────────── 401 TOKEN_REUSE — all sessions killed


  POST /logout ────────────────► verifyRefreshToken(token)
  { refreshToken }                redis.del(rt:<userId>) ────────► Redis
                ◄────────────── 200 Logged out


┌─────────────────────────────────────────────────────────────────────────┐
│                       RATE LIMIT FLOW                                   │
└─────────────────────────────────────────────────────────────────────────┘

  Failed login attempt:
    redis.incr(login_attempts:<ip>)
    if count == 1 → redis.expire(key, 15min)
    if count >= 5 → redis.expire(key, 30min)  ← extend lock window

  Next request from that IP:
    redis.get(login_attempts:<ip>) >= 5 → 429 Too Many Requests
```

---

## Project Structure

```
jwt-auth-api/
├── server.js                   ← Entry point — starts server, connects DB & Redis
├── app.js                      ← Express app — middleware, routes, error handlers
├── .env                        ← Environment variables (never commit this)
├── package.json
└── src/
    ├── config/
    │   ├── db.js               ← PostgreSQL pool (pg)
    │   └── redis.js            ← Redis client (ioredis) with retry strategy
    ├── controllers/
    │   └── authController.js   ← register, login, refresh, logout, me
    ├── middleware/
    │   ├── auth.js             ← JWT Bearer token verification
    │   └── rateLimit.js        ← Redis-backed login rate limiter
    ├── routes/
    │   └── auth.js             ← Route definitions → controller mapping
    └── utils/
        └── tokens.js           ← JWT sign/verify + SHA-256 hash utility
```

---

## Setup

### 1. Install dependencies

```bash
npm install express pg bcrypt jsonwebtoken ioredis dotenv
npm install -D nodemon
```

### 2. Configure `.env`

```env
PORT=3000

# Postgres
DB_HOST=localhost
DB_PORT=5432
DB_NAME=jwt_auth
DB_USER=postgres
DB_PASSWORD=yourpassword

# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# JWT secrets — generate with:
# node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
ACCESS_TOKEN_SECRET=your_access_token_secret_here
REFRESH_TOKEN_SECRET=your_refresh_token_secret_here

ACCESS_TOKEN_EXPIRY=15m
REFRESH_TOKEN_EXPIRY=7d
REFRESH_TOKEN_EXPIRY_SECONDS=604800
```

### 3. Create the database

Run in `psql`:

```sql
CREATE DATABASE jwt_auth;
\c jwt_auth

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_users_email ON users(email);
```

### 4. Run the server

```bash
npm run dev
```

---

## API Endpoints

| Method | Endpoint            | Auth Required | Description                        |
|--------|---------------------|---------------|------------------------------------|
| POST   | `/api/auth/register`| ✗             | Create a new user account          |
| POST   | `/api/auth/login`   | ✗             | Login and receive token pair       |
| POST   | `/api/auth/refresh` | ✗             | Rotate tokens using refresh token  |
| POST   | `/api/auth/logout`  | ✗             | Invalidate refresh token in Redis  |
| GET    | `/api/auth/me`      | ✓ Bearer JWT  | Get current user from access token |

---

## File-by-File Walkthrough

### `src/config/db.js`
Uses `pg.Pool` (not `Client`) to manage multiple simultaneous connections.
A single `Client` would block every request behind one connection.
Pool size is capped at 10 with idle and connection timeouts. Connection is tested on startup — fail fast if Postgres is misconfigured.

### `src/config/redis.js`
Uses `ioredis` for automatic reconnection and native Promise support.
Implements exponential backoff retry (up to 3s delay, max 10 retries) before giving up.

### `src/utils/tokens.js`
- `generateAccessToken` — signs a JWT with `sub: userId`, 15m expiry
- `generateRefreshToken` — signs a JWT with `sub: userId`, 7d expiry
- `verifyAccessToken` / `verifyRefreshToken` — verifies signature, expiry, and issuer
- `hashToken` — SHA-256 hashes a token for safe Redis storage

> **Why SHA-256 over bcrypt for tokens?**
> bcrypt is intentionally slow (for passwords). Token hashing needs to be fast — it happens on every `/refresh` call. SHA-256 is cryptographically strong enough here.

### `src/middleware/auth.js`
Extracts the Bearer token from the `Authorization` header, verifies it with `verifyAccessToken`, and attaches `req.userId = decoded.sub`.
Returns `TOKEN_EXPIRED` code so the client can silently trigger a refresh.
**No DB call** — the JWT signature is self-verifying.

### `src/middleware/rateLimit.js`
Redis-backed sliding window counter per IP.
- `loginRateLimit` — checks the counter before the login handler runs
- `recordFailedAttempt` — increments the counter, sets TTL on first hit, extends to 30min on 5th hit
- `clearFailedAttempts` — deletes the key on successful login

> **Why Redis over in-memory?** In-memory rate limiting breaks with 2+ Node processes (e.g., PM2). Redis is shared across all instances.

> **Fail-open on Redis errors** — If Redis is down, we allow the request rather than blocking all logins. Deliberate tradeoff: availability > security during outages.

### `src/controllers/authController.js`

**`register`**
1. Validates email and password
2. Checks for duplicate email **before** bcrypt hashing (saves ~250ms on duplicates)
3. Hashes password with `bcrypt` at 12 rounds
4. Inserts user into PostgreSQL
5. Returns `201` with user object (no tokens — user must login separately)

**`login`**
1. Fetches user by email
2. **Always runs `bcrypt.compare`** — even for non-existent users (prevents timing-based email enumeration)
3. Records failed attempts in Redis
4. On success: generates access + refresh tokens, stores `SHA256(refreshToken)` in Redis with 7d TTL

**`refresh`**
1. Verifies refresh token JWT signature
2. Fetches the stored hash from Redis (`rt:<userId>`)
3. Compares `SHA256(incomingToken)` vs stored hash
4. **Mismatch = reuse detected** → deletes all sessions, returns `401 TOKEN_REUSE`
5. On match: generates new token pair, overwrites Redis with new hash (rotation)

**`logout`**
1. Verifies refresh token to extract `userId`
2. Deletes `rt:<userId>` from Redis
3. Returns `200` even if token is already invalid (client wants out — don't punish them)

**`me`**
1. Requires `authenticate` middleware
2. Fetches user from DB by `req.userId`
3. Handles edge case: user deleted from DB but token still valid → `404`

### `src/routes/auth.js`
Wires routes to controllers. Rate limiter runs **before** the login handler via middleware chaining.

### `app.js`
- `express.json()` — parses JSON bodies (without this, `req.body` is `undefined`)
- `trust proxy 1` — correct `req.ip` behind nginx/load balancers (critical for rate limiting)
- 404 handler for unmatched routes
- Global error handler for anything passed via `next(err)`

### `server.js`
Imports `db.js` and `redis.js` here (not in `app.js`) so connections are established at startup, not on the first request.

---

## Postman Test Sequence

Run these **in order**:

**1. Register**
```
POST http://localhost:3000/api/auth/register
Body: { "email": "test@example.com", "password": "password123" }
Expected: 201 + user object
```

**2. Register same email again**
```
POST http://localhost:3000/api/auth/register
Body: { "email": "test@example.com", "password": "password123" }
Expected: 409 Conflict
```

**3. Login**
```
POST http://localhost:3000/api/auth/login
Body: { "email": "test@example.com", "password": "password123" }
Expected: 200 + accessToken + refreshToken
→ SAVE both tokens
```

**4. Hit /me with the access token**
```
GET http://localhost:3000/api/auth/me
Header: Authorization: Bearer <your_access_token>
Expected: 200 + user object
```

**5. Hit /me with a bad token**
```
GET http://localhost:3000/api/auth/me
Header: Authorization: Bearer garbage123
Expected: 401 Invalid access token
```

**6. Refresh tokens**
```
POST http://localhost:3000/api/auth/refresh
Body: { "refreshToken": "<your_refresh_token>" }
Expected: 200 + NEW accessToken + NEW refreshToken
→ SAVE the new refresh token, discard the old one
```

**7. Replay the OLD refresh token (reuse detection)**
```
POST http://localhost:3000/api/auth/refresh
Body: { "refreshToken": "<the OLD refresh token>" }
Expected: 401 + code: "TOKEN_REUSE" + all sessions invalidated
```

**8. Test brute force protection**
```
POST http://localhost:3000/api/auth/login
Body: { "email": "test@example.com", "password": "wrongpassword" }
→ Hit 5 times
→ 6th attempt: 429 Too Many Requests
```

**9. Logout**
```
POST http://localhost:3000/api/auth/logout
Body: { "refreshToken": "<your_current_refresh_token>" }
Expected: 200 Logged out
```

**10. Try to refresh after logout**
```
POST http://localhost:3000/api/auth/refresh
Body: { "refreshToken": "<the same token>" }
Expected: 401 Refresh token not found
```

---

## Key Security Concepts

| Concept | Implementation | Why It Matters |
|---|---|---|
| Stateless access tokens | JWT verified with crypto, no DB | Scales to any number of servers |
| Stateful refresh tokens | SHA-256 hash stored in Redis | Enables revocation and rotation |
| Token rotation | New refresh token on every `/refresh` | One-time-use tokens |
| Reuse detection | Hash mismatch → nuke all sessions | Detects stolen tokens post-rotation |
| Timing attack prevention | bcrypt runs even for missing users | Prevents email enumeration |
| Redis rate limiting | Shared counter across all processes | Works with PM2, clusters, k8s |
| Hashing in Redis | SHA-256(token) stored, never raw | Redis breach ≠ valid tokens |
| bcrypt rounds = 12 | ~250ms per hash | Slow enough to deter brute force |

---

## Commit Convention

```
feat(auth): implement JWT auth with token rotation and reuse detection

- Register endpoint with bcrypt (12 rounds) and duplicate email check
- Login with timing-attack-safe bcrypt comparison
- Redis rate limiting: 5 attempts / 15min window, 30min lockout
- Refresh endpoint with SHA-256 token hashing and reuse detection
- Logout clears Redis entry for clean session termination
- Auth middleware for stateless access token verification
```

---

## Tech Stack

| Package | Role |
|---|---|
| `express` | HTTP server and routing |
| `pg` | PostgreSQL client (connection pooling) |
| `bcrypt` | Password hashing |
| `jsonwebtoken` | JWT sign and verify |
| `ioredis` | Redis client with auto-reconnect |
| `dotenv` | Environment variable loading |
| `nodemon` | Dev server with auto-restart |
