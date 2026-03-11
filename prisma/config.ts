/**
 * Prisma configuration for connection URLs
 * Prisma 7+ requires connection URLs to be defined here instead of schema.prisma
 */

import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required');
}

// Create a connection pool for the adapter
const pool = new Pool({
  connectionString,
});

// Export the adapter for use in PrismaClient
export const adapter = new PrismaPg(pool);

// Export connection string for migrations
export { connectionString };
