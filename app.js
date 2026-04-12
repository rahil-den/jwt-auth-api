require('dotenv').config();
const express = require('express');
const authRoutes = require('./src/routes/auth');

const app = express();

// WHY: express.json() parses the request body.
// Without this, req.body is always undefined.
app.use(express.json());

// WHY: Trust the first proxy hop (for correct req.ip behind nginx/load balancers)
// Without this, req.ip would always be the proxy's IP, making rate limiting useless.
app.set('trust proxy', 1);

// Routes
app.use('/api/auth', authRoutes);

// 404 handler — catches unmatched routes
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// Global error handler — last middleware, catches anything next(err) sends
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ success: false, message: 'Internal server error' });
});

module.exports = app;