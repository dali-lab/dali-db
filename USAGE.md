# Using the Shared Database Schema

All database schemas are defined in `dali-db/prisma/schema.prisma`. This is the **single source of truth** for all database structures across all DALI services.

## For Service Developers

### Option 1: Import from dali-db (Recommended for Monorepo)

If `dali-db` is set up as a workspace package:

```typescript
// In dali-edu or dali-web
import { prisma } from '@dali/db/lib/prisma.js';

// Use Prisma with full type safety
const user = await prisma.user.findUnique({
  where: { email: 'user@dartmouth.edu' },
});

const cache = await prisma.teamMembersCache.findUnique({
  where: { id: 'current' },
});
```

### Option 2: Symlink Generated Client (Development)

For development, symlink the generated Prisma client:

```bash
# In dali-edu
cd src/lib
ln -s ../../../dali-db/lib/generated prisma-client
```

Then import:
```typescript
import { PrismaClient } from './lib/prisma-client/index.js';

const prisma = new PrismaClient();
```

### Option 3: Copy Generated Client

Copy the generated client after each schema change:

```bash
# After running npm run db:generate in dali-db
cp -r dali-db/lib/generated dali-edu/src/lib/prisma-client
```

## Schema Organization

All schemas are in `dali-db/prisma/schema.prisma`:

### dali_edu Schema
- `User` - User accounts
- `Course` - Course information
- `Enrollment` - Student enrollments

### dali_web Schema
- `TeamMembersCache` - Cached team member data
- `ProjectsCache` - Cached project data
- `ProjectDetailsCache` - Cached project details

### shared Schema
- `AuditLog` - Shared audit logging

## Adding New Models

1. **Edit `dali-db/prisma/schema.prisma`**
2. **Generate Prisma Client:**
   ```bash
   cd dali-db
   npm run db:generate
   ```
3. **Push to database:**
   ```bash
   npm run db:push  # Development
   # or
   npm run db:migrate  # Production
   ```
4. **Update services** to use the new model

## Example: Adding a Model

```prisma
// In dali-db/prisma/schema.prisma

model Assignment {
  id        String   @id @default(uuid()) @db.Uuid
  courseId  String   @map("course_id") @db.Uuid
  title     String   @db.VarChar(255)
  dueDate   DateTime @map("due_date") @db.Timestamptz(6)
  createdAt DateTime @default(now()) @map("created_at") @db.Timestamptz(6)

  course    Course   @relation(fields: [courseId], references: [id])

  @@schema("dali_edu")
  @@map("assignments")
  @@index([courseId])
}
```

Then update the Course model to include the relation:

```prisma
model Course {
  // ... existing fields
  assignments Assignment[]  // Add this line
}
```

## Type Safety

All Prisma models are fully typed. TypeScript will:
- ✅ Autocomplete field names
- ✅ Validate field types
- ✅ Check relations
- ✅ Error on invalid queries

```typescript
// TypeScript knows the exact shape
const user: User = await prisma.user.findUnique({
  where: { email: 'user@dartmouth.edu' },
});

// TypeScript error if field doesn't exist
console.log(user.invalidField); // ❌ Error
```

## Best Practices

1. **Always define schemas in `dali-db/prisma/schema.prisma`**
   - Don't create schemas in individual services
   - Keep all database definitions centralized

2. **Use migrations for production**
   ```bash
   npm run db:migrate  # Creates migration file
   ```

3. **Use db:push for development**
   ```bash
   npm run db:push  # Quick iteration
   ```

4. **Document schema changes**
   - Add comments in schema.prisma
   - Update migration descriptions

5. **Test schema changes**
   - Run `npm run db:studio` to visually verify
   - Test queries in your service code

## Troubleshooting

### "Cannot find module './generated'"
Run `npm run db:generate` in `dali-db` first.

### "Schema out of sync"
Run `npm run db:push` or `npm run db:migrate` in `dali-db`.

### "Type errors after schema change"
1. Run `npm run db:generate` in `dali-db`
2. Restart your TypeScript server
3. Rebuild your service
