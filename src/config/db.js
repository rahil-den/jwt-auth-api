// Database configuration
// - Connect to PostgreSQL using the pg library
// - Export the pool/client for use in controllers
const {Pool} = require('pg');

const pool = new Pool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT, 10),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  max: 10,                // max 10 simultaneous connections in the pool
  idleTimeoutMillis: 30000, // close idle connections after 30s
  connectionTimeoutMillis: 2000, // throw if can't get a connection in 2s
});

pool.connect((err,client,release) => {
    if(err){
        console.log('Postgres connection error: ', err.message);
    }
    console.log('Postgres connected');
    release();
});

module.exports = pool;