require('dotenv').config();
const app = require('./app');

// WHY: We import db and redis here (not in app.js) so the connection
// is established when the server starts, not when the first request arrives.
require('./src/config/db');
require('./src/config/redis');

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});