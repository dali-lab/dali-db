/**
 * Shared database connection utility
 * This can be imported by any dali-* service to connect to the shared PostgreSQL database
 */

import { Pool, PoolConfig } from 'pg';

let pool: Pool | null = null;

export interface DatabaseConfig {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  connectionString?: string;
  schema?: string; // Default schema to use
}

/**
 * Initialize database connection pool
 */
export const initDatabase = (config?: DatabaseConfig): Pool => {
  if (pool) {
    return pool;
  }

  const poolConfig: PoolConfig = {
    connectionString: config?.connectionString || process.env.DATABASE_URL,
    host: config?.host || process.env.DB_HOST || 'localhost',
    port: config?.port || parseInt(process.env.DB_PORT || '5432'),
    database: config?.database || process.env.DB_NAME || 'dali_db',
    user: config?.user || process.env.DB_USER || 'dali',
    password: config?.password || process.env.DB_PASSWORD || 'dali_password',
    max: 20, // Maximum number of clients in the pool
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  };

  pool = new Pool(poolConfig);

  // Handle pool errors
  pool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
  });

  // Set default schema if provided
  if (config?.schema) {
    pool.on('connect', async (client) => {
      await client.query(`SET search_path TO ${config.schema}, public`);
    });
  }

  return pool;
};

/**
 * Get the database connection pool
 */
export const getDatabase = (): Pool => {
  if (!pool) {
    return initDatabase();
  }
  return pool;
};

/**
 * Close database connection pool
 */
export const closeDatabase = async (): Promise<void> => {
  if (pool) {
    await pool.end();
    pool = null;
  }
};

/**
 * Execute a query
 */
export const query = async <T = unknown>(
  text: string,
  params?: unknown[]
): Promise<T[]> => {
  const db = getDatabase();
  const result = await db.query(text, params);
  return result.rows as T[];
};

/**
 * Execute a query and return a single row
 */
export const queryOne = async <T = unknown>(
  text: string,
  params?: unknown[]
): Promise<T | null> => {
  const db = getDatabase();
  const result = await db.query(text, params);
  return (result.rows[0] as T) || null;
};

/**
 * Health check function
 */
export const healthCheck = async (): Promise<{
  status: string;
  timestamp: string;
  database: string;
  version: string;
}> => {
  const result = await queryOne<{
    health: {
      status: string;
      timestamp: string;
      database: string;
      version: string;
    };
  }>('SELECT shared.health_check() as health');

  if (!result || !result.health) {
    throw new Error('Health check failed');
  }

  return result.health;
};
