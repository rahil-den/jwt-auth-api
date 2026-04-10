# JWT Auth API

A backend auth system built with **Express**, **PostgreSQL**, **Redis**, and **JWT** — following the same stateless-auth + stateful-refresh pattern used in production at companies like Razorpay and Groww.

**What it does in plain English:**
- You log in → you get two tokens: a short-lived access token (15 min) and a long-lived refresh token (7 days)
- Every protected route is verified with pure crypto — no database hit needed
- When your access token expires, you hit `/refresh` to get a new pair — the old one is immediately invalidated
- If someone steals and replays an old refresh token, the system detects it and kills every active session

---

## How it Works

```
  REGISTER
  ────────
  Client ──POST /register──► Validate → Check duplicate → bcrypt hash → Save to Postgres
         ◄── 201 { user } ──────────────────────────────────────────────────────────────


  LOGIN
  ─────
  Client ──POST /login──► Rate limit check (Redis)
                          Fetch user (Postgres)
                          bcrypt.compare()  ← always runs, even for fake users*
                          Generate accessToken (15m JWT)
                          Generate refreshToken (7d JWT)
                          Store SHA256(refreshToken) in Redis with 7d TTL
         ◄── 200 { accessToken, refreshToken } ────────────────────────────────────────

  * Running bcrypt for non-existent users prevents timing attacks that reveal valid emails


  PROTECTED ROUTE  (e.g. GET /me)
  ───────────────
  Client ──GET /me──► authenticate middleware
  Authorization:       Extract "Bearer <token>" from header
  Bearer <token>       jwt.verify(token)  ← pure crypto, zero DB calls
                       req.userId = decoded.sub
                       Fetch user from Postgres
         ◄── 200 { user } ──────────────────────────────────────────────────────────────


  REFRESH
  ───────
  Client ──POST /refresh──► Verify refresh token JWT signature
         { refreshToken }   Fetch SHA256 hash from Redis
                            Hash incoming token → compare
                            │
                            ├── MATCH → Generate new token pair
                            │          Store new hash in Redis (old one is gone)
                            │   ◄── 200 { newAccessToken, newRefreshToken } ──────────
                            │
                            └── MISMATCH → Token reuse detected*
                                           Delete all sessions from Redis
                                ◄── 401 { code: "TOKEN_REUSE" } ───────────────────────

  * A valid JWT that doesn't match the Redis hash = it was already rotated.
    This means the token was stolen. Response: nuke everything.


  LOGOUT
  ──────
  Client ──POST /logout──► Verify refresh token → Get userId
         { refreshToken }   redis.del(rt:<userId>)
         ◄── 200 Logged out ─────────────────────────────────────────────────────────


  RATE LIMITING  (on login)
  ─────────────
  Failed attempt → redis.incr(login_attempts:<ip>)
                   EXPIRE key at 15 min (set only on first failure)
                   On 5th failure → extend lock to 30 min

  Next request  → redis.get(login_attempts:<ip>) >= 5
               ◄── 429 Too Many Requests
```

---

## Stack

| Package | What it does here |
|---|---|
| `express` | HTTP server and routing |
| `pg` | PostgreSQL connection pool |
| `bcrypt` | Password hashing (12 rounds ≈ 250ms per hash) |
| `jsonwebtoken` | Sign and verify JWTs |
| `ioredis` | Redis client with auto-reconnect |
| `dotenv` | Load `.env` into `process.env` |
| `nodemon` | Dev server with auto-restart |

---

## Project Structure

```
jwt-auth-api/
├── server.js                    ← Starts server, triggers DB + Redis connections
├── app.js                       ← Express app config, routes, error handlers
├── .env                         ← Secrets (never commit this)
└── src/
    ├── config/
    │   ├── db.js                ← PostgreSQL pool setup
    │   └── redis.js             ← Redis client with retry backoff
    ├── controllers/
    │   └── authController.js    ← register, login, refresh, logout, me
    ├── middleware/
    │   ├── auth.js              ← Verifies Bearer token on protected routes
    │   └── rateLimit.js        ← Tracks failed logins per IP in Redis
    ├── routes/
    │   └── auth.js              ← Maps endpoints to controllers
    └── utils/
        └── tokens.js            ← JWT helpers + SHA-256 token hasher
```

---

## Setup

**1. Install dependencies**

```bash
npm install express pg bcrypt jsonwebtoken ioredis dotenv
npm install -D nodemon
```

**2. Set up `.env`**

```env
PORT=3000

DB_HOST=localhost
DB_PORT=5432
DB_NAME=jwt_auth
DB_USER=postgres
DB_PASSWORD=yourpassword

REDIS_HOST=localhost
REDIS_PORT=6379

# Generate with: node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
ACCESS_TOKEN_SECRET=your_access_token_secret_here
REFRESH_TOKEN_SECRET=your_refresh_token_secret_here

ACCESS_TOKEN_EXPIRY=15m
REFRESH_TOKEN_EXPIRY=7d
REFRESH_TOKEN_EXPIRY_SECONDS=604800
```

**3. Create the database**

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

**4. Run**

```bash
npm run dev
```

---

## Endpoints

| Method | Endpoint | Protected | What it does |
|---|---|---|---|
| POST | `/api/auth/register` | ✗ | Creates a new user |
| POST | `/api/auth/login` | ✗ | Returns access + refresh tokens |
| POST | `/api/auth/refresh` | ✗ | Rotates token pair using refresh token |
| POST | `/api/auth/logout` | ✗ | Deletes refresh token from Redis |
| GET  | `/api/auth/me` | ✓ Bearer | Returns current user's profile |

---

## Testing with Postman

Run these in order — each step builds on the last.

**Step 1 — Register**
```
POST /api/auth/register
{ "email": "test@example.com", "password": "password123" }
→ 201 with user object
```

**Step 2 — Try to register the same email**
```
POST /api/auth/register
{ "email": "test@example.com", "password": "password123" }
→ 409 Conflict
```

**Step 3 — Login** *(save both tokens)*
```
POST /api/auth/login
{ "email": "test@example.com", "password": "password123" }
→ 200 with accessToken + refreshToken
```

**Step 4 — Hit a protected route**
```
GET /api/auth/me
Authorization: Bearer <your_access_token>
→ 200 with user profile
```

**Step 5 — Hit it with a bad token**
```
GET /api/auth/me
Authorization: Bearer garbage
→ 401 Invalid access token
```

**Step 6 — Refresh your tokens** *(save the NEW refresh token)*
```
POST /api/auth/refresh
{ "refreshToken": "<your_refresh_token>" }
→ 200 with brand new accessToken + refreshToken
```

**Step 7 — Replay the OLD refresh token**
```
POST /api/auth/refresh
{ "refreshToken": "<the OLD refresh token>" }
→ 401 TOKEN_REUSE — all sessions killed
```

**Step 8 — Trigger rate limiting**
```
POST /api/auth/login with wrong password — repeat 5 times
6th attempt → 429 Too Many Requests
```

**Step 9 — Logout**
```
POST /api/auth/logout
{ "refreshToken": "<current_refresh_token>" }
→ 200 Logged out
```

**Step 10 — Refresh after logout**
```
POST /api/auth/refresh
{ "refreshToken": "<same token>" }
→ 401 Refresh token not found
```

---

## Key Design Decisions

**Why hash refresh tokens in Redis?**
If Redis is ever compromised, the attacker gets SHA-256 hashes — not valid tokens. Same reason you store password hashes instead of passwords.

**Why SHA-256 instead of bcrypt for tokens?**
bcrypt is intentionally slow (that's the point for passwords). Hashing a token on every `/refresh` call needs to be fast. SHA-256 is cryptographically strong and takes microseconds.

**Why run bcrypt even when the user doesn't exist?**
If you return early on "user not found", an attacker can measure how fast the response is. bcrypt taking ~250ms reveals which emails exist. Always run it.

**Why Redis for rate limiting instead of in-memory?**
In-memory counters live per-process. With 2 Node instances (PM2, clusters), each tracks its own count — the limit is effectively doubled. Redis is shared across all instances.

**Why `trust proxy 1` in app.js?**
Behind nginx or a load balancer, `req.ip` would always be the proxy's IP without this. Every user would share the same rate limit counter. One bad actor locks everyone out.
