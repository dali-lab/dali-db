.PHONY: up down logs ps shell backup restore reset health install db-generate db-push db-migrate db-studio db-seed

# Start the database
up:
	docker-compose up -d

# Stop the database
down:
	docker-compose down

# View logs
logs:
	docker-compose logs -f postgres

# Check status
ps:
	docker-compose ps

# Access PostgreSQL shell
shell:
	docker-compose exec postgres psql -U dali -d dali_db

# Backup database
backup:
	docker-compose exec postgres pg_dump -U dali dali_db > backup_$(shell date +%Y%m%d_%H%M%S).sql
	@echo "Backup created: backup_$(shell date +%Y%m%d_%H%M%S).sql"

# Restore database (usage: make restore FILE=backup.sql)
restore:
	@if [ -z "$(FILE)" ]; then \
		echo "Usage: make restore FILE=backup.sql"; \
		exit 1; \
	fi
	docker-compose exec -T postgres psql -U dali dali_db < $(FILE)

# Reset database (⚠️ deletes all data)
reset:
	docker-compose down -v
	docker-compose up -d
	npm run db:push

# Health check
health:
	docker-compose exec postgres psql -U dali -d dali_db -c "SELECT shared.health_check();"

# Install dependencies
install:
	npm install

# Prisma: Generate client
db-generate:
	npm run db:generate

# Prisma: Push schema (development)
db-push:
	npm run db:push

# Prisma: Create migration
db-migrate:
	npm run db:migrate

# Prisma: Open Studio
db-studio:
	npm run db:studio

# Prisma: Run seed
db-seed:
	npm run db:seed

# Setup: Install deps, generate client, push schema
setup: install db-generate db-push
	@echo "✅ Database setup complete!"
