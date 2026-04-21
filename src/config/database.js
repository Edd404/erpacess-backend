const { Pool } = require('pg');
const logger = require('../utils/logger');

// ── Supabase usa SSL obrigatório e aceita DATABASE_URL direto ──
const poolConfig = process.env.DATABASE_URL
  ? {
      // Modo Supabase: usa a connection string completa
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Supabase exige SSL
      max: parseInt(process.env.DB_POOL_MAX) || 10,
      idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT) || 30000,
      connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONNECT_TIMEOUT) || 10000,
    }
  : {
      // Modo local/tradicional: variáveis separadas
      host: process.env.DB_HOST,
      port: parseInt(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
      max: parseInt(process.env.DB_POOL_MAX) || 10,
      idleTimeoutMillis: parseInt(process.env.DB_POOL_IDLE_TIMEOUT) || 30000,
      connectionTimeoutMillis: parseInt(process.env.DB_POOL_CONNECT_TIMEOUT) || 10000,
    };

const pool = new Pool(poolConfig);

pool.on('connect', () => {
  logger.debug('Nova conexão estabelecida com o banco de dados');
});

pool.on('error', (err) => {
  logger.error('Erro inesperado no pool de conexões:', err);
});

/**
 * Executa uma query com prepared statements (proteção contra SQL Injection)
 */
const query = async (text, params) => {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug('Query executada', { text, duration, rows: result.rowCount });
    return result;
  } catch (error) {
    logger.error('Erro na query:', { text, error: error.message });
    throw error;
  }
};

/**
 * Executa múltiplas queries em uma transação
 */
const transaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Transação revertida (rollback):', error.message);
    throw error;
  } finally {
    client.release();
  }
};

/**
 * Verifica a saúde da conexão com o banco
 */
const healthCheck = async () => {
  try {
    const result = await query('SELECT NOW() as timestamp');
    return { healthy: true, timestamp: result.rows[0].timestamp };
  } catch (error) {
    return { healthy: false, error: error.message };
  }
};

module.exports = { query, transaction, healthCheck, pool };
