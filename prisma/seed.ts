/**
 * Prisma seed script for shared database
 * Run with: npm run db:seed
 */

import { PrismaClient } from '../lib/generated/index.js';
import { adapter } from './config.js';

const prisma = new PrismaClient({ adapter });

async function main() {
  console.log('🌱 Seeding shared database...');

  // Example: Create a test user in dali_edu
  const user = await prisma.user.upsert({
    where: { email: 'test@dartmouth.edu' },
    update: {},
    create: {
      email: 'test@dartmouth.edu',
      name: 'Test User',
      emailVerified: true,
    },
  });

  console.log('✅ Created user:', user);

  // Example: Initialize team members cache in dali_web
  const cache = await prisma.teamMembersCache.upsert({
    where: { id: 'current' },
    update: {},
    create: {
      id: 'current',
      data: [],
      totalCount: 0,
    },
  });

  console.log('✅ Initialized cache:', cache);

  console.log('✅ Seeding completed!');
}

main()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
