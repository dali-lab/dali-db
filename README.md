# DALI Shared Database

Shared PostgreSQL database with Prisma for all DALI services (`dali-web`, `dali-edu`, etc.).

## Quick Start

### Prerequisites

- Docker and Docker Compose installed
- Node.js 18+ and npm
- Ports 5432 (PostgreSQL) and 5050 (pgAdmin) available

### Setup

1. **Start the database:**
   ```bash
   docker-compose up -d
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up environment variables:**
   ```bash
   # Create .env file
   echo "DATABASE_URL=postgresql://dali:dali_password@localhost:5432/dali_db" > .env
   ```

4. **Generate Prisma Client:**
   ```bash
   npm run db:generate
   ```

5. **Push schema to database:**
   ```bash
   npm run db:push
   ```

## Database Structure

The database uses PostgreSQL with multiple schemas:

- **`dali_edu`** - Education service tables (User, Course, Enrollment)
- **`dali_web`** - Web service tables (TeamMembersCache, ProjectsCache, etc.)
- **`shared`** - Shared tables (AuditLog)

All schemas are defined in `prisma/schema.prisma`.

## Prisma Commands

```bash
# Generate Prisma Client (after schema changes)
npm run db:generate

# Push schema changes to database (development)
npm run db:push

# Create and apply a migration (recommended for production)
npm run db:migrate

# Deploy migrations (production)
npm run db:migrate:deploy

# Open Prisma Studio (database GUI)
npm run db:studio

# Run seed script
npm run db:seed

# Reset database (⚠️ deletes all data)
npm run db:reset
```

## Using Prisma in Your Services

### Option 1: Import from dali-db (Recommended)

If `dali-db` is a shared package:

```typescript
// In dali-edu or dali-web
import { prisma } from '@dali/db/lib/prisma.js';

const user = await prisma.user.findUnique({
  where: { email: 'user@dartmouth.edu' },
});
```

### Option 2: Copy Prisma Client

After generating Prisma Client in `dali-db`, you can copy the generated client to your service:

```bash
# In dali-edu
cp -r ../dali-db/lib/generated ./src/lib/prisma-client
```

Then import:
```typescript
import { PrismaClient } from './lib/prisma-client/index.js';
```

### Option 3: Symlink (Development)

For development, you can symlink:

```bash
# In dali-edu
ln -s ../../dali-db/lib/generated ./src/lib/prisma-client
```

## Connection Details

**PostgreSQL:**
- Host: `localhost`
- Port: `5432` (or value from `.env`)
- Database: `dali_db` (or value from `.env`)
- User: `dali` (or value from `.env`)
- Password: `dali_password` (or value from `.env`)

**Connection String:**
```
postgresql://dali:dali_password@localhost:5432/dali_db
```

**pgAdmin (Optional):**
- URL: `http://localhost:5050`
- Email: `admin@dali.edu` (or value from `.env`)
- Password: `admin` (or value from `.env`)

## Schema Management

All database schemas are defined in `prisma/schema.prisma`. This is the **single source of truth** for all database structures.

### Adding a New Model

1. Edit `prisma/schema.prisma`
2. Run `npm run db:generate` to generate Prisma Client
3. Run `npm run db:push` (development) or `npm run db:migrate` (production)

### Example: Adding a Model

```prisma
// In prisma/schema.prisma
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

## Multi-Schema Support

Prisma supports multiple PostgreSQL schemas. Models are organized by schema:

```prisma
model User {
  // ... fields
  @@schema("dali_edu")  // This model is in the dali_edu schema
  @@map("users")
}

model TeamMembersCache {
  // ... fields
  @@schema("dali_web")  // This model is in the dali_web schema
  @@map("team_members_cache")
}
```

## Management Commands

### Start database
```bash
docker-compose up -d
```

### Stop database
```bash
docker-compose down
```

### View logs
```bash
docker-compose logs -f postgres
```

### Access PostgreSQL CLI
```bash
docker-compose exec postgres psql -U dali -d dali_db
```

### Backup database
```bash
docker-compose exec postgres pg_dump -U dali dali_db > backup.sql
```

### Restore database
```bash
docker-compose exec -T postgres psql -U dali dali_db < backup.sql
```

### Reset database (⚠️ deletes all data)
```bash
docker-compose down -v
docker-compose up -d
npm run db:push
```

## Prisma Studio

Visual database browser:

```bash
npm run db:studio
```

Opens at `http://localhost:5555` - browse all tables across all schemas.

## Environment Variables

Create a `.env` file:

```env
DATABASE_URL=postgresql://dali:dali_password@localhost:5432/dali_db
```

## Troubleshooting

### "Prisma Client not generated"
Run: `npm run db:generate`

### "Schema out of sync"
Run: `npm run db:push` or `npm run db:migrate`

### "Connection refused"
- Make sure the database is running: `docker-compose up -d`
- Check `DATABASE_URL` in `.env`

### "Schema does not exist"
The `init/01-init.sql` script creates the schemas automatically when the database container is first created.

## Resources

- [Prisma Documentation](https://www.prisma.io/docs)
- [Prisma Schema Reference](https://www.prisma.io/docs/reference/api-reference/prisma-schema-reference)
- [Prisma Client API](https://www.prisma.io/docs/reference/api-reference/prisma-client-reference)
