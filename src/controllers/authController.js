// Auth Controller
// - register: hash password, save user to DB, return tokens
// - login: verify credentials, return access + refresh tokens
// - logout: blacklist the token in Redis
// - refresh: validate refresh token, issue new access token
