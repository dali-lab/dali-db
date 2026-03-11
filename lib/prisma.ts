/**
 * Prisma Client singleton for shared database
 * All DALI services should import from this file
 */

// Import Prisma Client from generated location
// After running `npm run db:generate`, the client will be in ./generated
import { PrismaClient } from './generated/index.js';

declare global {
  // eslint-disable-next-line no-var
  var prisma: PrismaClient | undefined;
}

export const prisma =
  global.prisma ||
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
  });

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}

// Graceful shutdown
process.on('beforeExit', async () => {
  await prisma.$disconnect();
});

export default prisma;

// Re-export types for convenience
export * from './generated/index.js';
