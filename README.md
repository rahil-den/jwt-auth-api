# 🔐 JWT Auth API

> **A production-grade stateless-auth + stateful-refresh system** — the same token rotation and reuse detection pattern used by companies like Razorpay and Groww.

![License](https://img.shields.io/badge/license-ISC-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-green.svg)
![Express](https://img.shields.io/badge/Express-5.x-000000.svg)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17-336791.svg)
![Redis](https://img.shields.io/badge/Redis-ioredis-DC382D.svg)

---

## 📋 Table of Contents

- [Overview](#-overview)
- [Architecture](#-architecture)
- [Tech Stack](#-tech-stack)
- [Project Structure](#-project-structure)
- [Why Hash Refresh Tokens?](#-why-hash-refresh-tokens)
- [Why Redis for Rate Limiting?](#-why-redis-for-rate-limiting)
- [Getting Started](#-getting-started)
- [API Reference](#-api-reference)
- [Testing with Postman](#-testing-with-postman)

---

## 🎯 Overview

JWT Auth API is a **backend authentication system** that handles:

| Feature | What it does |
|---------|-------------|
| **Register / Login** | Creates users, verifies credentials with bcrypt |
| **Access Tokens** | Short-lived JWTs (15 min) — verified with pure crypto, zero DB hits |
| **Refresh Tokens** | Long-lived JWTs (7 days) stored as SHA-256 hashes in Redis |
| **Token Rotation** | Every `/refresh` issues a new pair and invalidates the old one |
| **Reuse Detection** | Replaying a rotated token kills all active sessions immediately |
| **Rate Limiting** | Redis-backed login throttling — 5 attempts / 15 min, 30 min lockout |

### Key Security Decisions

- 🔒 **Refresh tokens are never stored raw** — only SHA-256 hashes live in Redis
- ⏱️ **bcrypt always runs** even for non-existent users (prevents email enumeration via timing)
- 🚨 **Token reuse = full session wipe** — a rotated token being replayed means it was stolen
- 🌐 **Redis rate limiting** works across multiple Node processes, unlike in-memory counters

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                              CLIENT                                     │
└───────────────────────────────┬─────────────────────────────────────────┘
                                │
                   ┌────────────▼────────────┐
                   │       Express API        │
                   │   /api/auth/* routes     │
                   └────────────┬────────────┘
                                │
         ┌──────────────────────┼──────────────────────┐
         │                      │                      │
┌────────▼────────┐   ┌────────▼────────┐   ┌────────▼────────┐
│   PostgreSQL    │   │     Redis       │   │   JWT Crypto    │
│   (users DB)    │   │  (token hashes  │   │  (stateless     │
│                 │   │  + rate limits) │   │   verification) │
└─────────────────┘   └─────────────────┘   └─────────────────┘


  REGISTER ──────────► Validate → Check duplicate (Postgres)
                        bcrypt.hash(password, 12)
                        INSERT user
                     ◄─ 201 { user }

  LOGIN ─────────────► Rate limit check (Redis)
                        Fetch user (Postgres)
                        bcrypt.compare()  ← always runs*
                        Generate accessToken (15m) + refreshToken (7d)
                        redis.setex(rt:<userId>, SHA256(refreshToken))
                     ◄─ 200 { accessToken, refreshToken }

  GET /me ───────────► authenticate middleware
  Bearer <token>         jwt.verify()  ← zero DB call
                         req.userId = decoded.sub
                         Fetch user (Postgres)
                      ◄─ 200 { user }

  REFRESH ───────────► Verify JWT signature
  { refreshToken }      redis.get(rt:<userId>)
                        Compare SHA256(incoming) vs stored hash
                        │
                        ├── MATCH ────► Rotate: new pair, new Redis hash
                        │           ◄── 200 { newAccessToken, newRefreshToken }
                        │
                        └── MISMATCH ──► redis.del(rt:<userId>)  ← nuke all sessions
                                     ◄── 401 { code: "TOKEN_REUSE" }

  LOGOUT ────────────► Verify token → extract userId
  { refreshToken }      redis.del(rt:<userId>)
                     ◄─ 200 Logged out

  * bcrypt runs even for non-existent users → prevents timing-based
    email enumeration (attacker can't tell which emails are registered)
```

---

## 🛠️ Tech Stack

| Technology | Purpose |
|------------|---------|
| **Express 5** | HTTP server and routing |
| **PostgreSQL** | User storage with UUID primary keys |
| **pg (Pool)** | Connection pooling — multiple concurrent requests |
| **bcrypt** | Password hashing at 12 rounds (~250ms per hash) |
| **jsonwebtoken** | Sign and verify access + refresh tokens |
| **ioredis** | Redis client with exponential backoff retry |
| **dotenv** | Load secrets from `.env` into `process.env` |
| **nodemon** | Dev server with auto-restart |

---

## 📁 Project Structure

```
jwt-auth-api/
├── server.js                    ← Entry point — starts server, connects DB + Redis
├── app.js                       ← Express config, routes, error handlers
├── .env                         ← Secrets (never commit this)
├── package.json
└── src/
    ├── config/
    │   ├── db.js                ← PostgreSQL Pool setup (tested on startup)
    │   └── redis.js             ← ioredis client with retry backoff
    ├── controllers/
    │   └── authController.js    ← register, login, refresh, logout, me
    ├── middleware/
    │   ├── auth.js              ← Bearer token extraction + JWT verification
    │   └── rateLimit.js        ← Redis failed-login counter per IP
    ├── routes/
    │   └── auth.js              ← Maps endpoints → middleware → controllers
    └── utils/
        └── tokens.js            ← generateAccessToken, generateRefreshToken,
                                    verifyAccessToken, verifyRefreshToken, hashToken
```

---

## 🔒 Why Hash Refresh Tokens?

Refresh tokens are stored in Redis as **SHA-256 hashes**, never as raw tokens.

```javascript
// tokens.js
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// authController.js — on login
const tokenHash = hashToken(refreshToken);
await redis.setex(`rt:${user.id}`, EXPIRY_SECONDS, tokenHash);

// authController.js — on refresh
const incomingHash = hashToken(refreshToken);
const storedHash = await redis.get(`rt:${userId}`);

if (incomingHash !== storedHash) {
  // Token reuse detected — invalidate everything
  await redis.del(`rt:${userId}`);
  return res.status(401).json({ code: 'TOKEN_REUSE' });
}
```

**Why SHA-256 and not bcrypt?**
bcrypt is intentionally slow (designed for passwords). Token comparison happens on every `/refresh` call and needs to be fast. SHA-256 takes microseconds and is cryptographically strong enough for this use case.

---

## 🚀 Why Redis for Rate Limiting?

Rate limiting is Redis-backed, not in-memory.

```javascript
// rateLimit.js
async function recordFailedAttempt(ip) {
  const key = `login_attempts:${ip}`;
  const count = await redis.incr(key);

  if (count === 1) await redis.expire(key, 15 * 60);   // 15 min window
  if (count >= 5)  await redis.expire(key, 30 * 60);   // extend lock on 5th failure
}
```

**Why not in-memory?**
In-memory counters are per-process. Run 2 Node instances with PM2 and the effective limit doubles — one attacker gets 10 attempts instead of 5. Redis is shared across all instances. The counter is always accurate.

**Fail-open on Redis errors** — if Redis is down, requests are allowed through. Deliberate tradeoff: availability over security during outages.

---

## 🚀 Getting Started

### Prerequisites

- Node.js ≥ 18.x
- PostgreSQL (local or hosted)
- Redis Server

### 1. Install dependencies

```bash
npm install
```

### 2. Configure `.env`

```bash
cp .env.example .env   # then fill in your values
```

### 3. Set up the database

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
npm run dev    # nodemon — restarts on file save
npm start      # node — production
```

---


## 📡 API Reference

| Method | Endpoint | Protected | Description |
|--------|----------|-----------|-------------|
| `POST` | `/api/auth/register` | ✗ | Create a new user account |
| `POST` | `/api/auth/login` | ✗ | Login and receive token pair |
| `POST` | `/api/auth/refresh` | ✗ | Rotate tokens using refresh token |
| `POST` | `/api/auth/logout` | ✗ | Invalidate refresh token in Redis |
| `GET`  | `/api/auth/me` | ✓ Bearer | Get current user profile |

### Request / Response Examples

**Register**
```json
POST /api/auth/register
{ "email": "user@example.com", "password": "password123" }

→ 201
{ "success": true, "user": { "id": "uuid", "email": "...", "createdAt": "..." } }
```

**Login**
```json
POST /api/auth/login
{ "email": "user@example.com", "password": "password123" }

→ 200
{ "success": true, "accessToken": "eyJ...", "refreshToken": "eyJ..." }
```

**Refresh**
```json
POST /api/auth/refresh
{ "refreshToken": "eyJ..." }

→ 200
{ "success": true, "accessToken": "eyJ...(new)", "refreshToken": "eyJ...(new)" }

→ 401 (reuse detected)
{ "success": false, "code": "TOKEN_REUSE", "message": "..." }
```

---

## 🧪 Testing with Postman

Run these **in order** — each step builds on the last.

| Step | Request | Expected |
|------|---------|----------|
| 1 | `POST /register` with valid credentials | `201` user object |
| 2 | `POST /register` with same email | `409` Conflict |
| 3 | `POST /login` *(save both tokens)* | `200` with token pair |
| 4 | `GET /me` with `Authorization: Bearer <accessToken>` | `200` user profile |
| 5 | `GET /me` with `Authorization: Bearer garbage` | `401` Invalid token |
| 6 | `POST /refresh` with refresh token *(save new token)* | `200` new token pair |
| 7 | `POST /refresh` with the **old** refresh token | `401` TOKEN_REUSE — all sessions killed |
| 8 | `POST /login` with wrong password × 5, then × 6 | `401` × 5, then `429` |
| 9 | `POST /logout` with current refresh token | `200` Logged out |
| 10 | `POST /refresh` after logout | `401` Token not found |

---

## 👥 Made by

- [Rahil](https://github.com/rahil-den)

---


<p align="center">
  Built while learning production-grade backend auth patterns 🚀
</p>
