-- Initialize shared DALI database
-- This script runs automatically when the database container is first created

-- Create extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Create schemas for different services
CREATE SCHEMA IF NOT EXISTS dali_web;
CREATE SCHEMA IF NOT EXISTS dali_edu;
CREATE SCHEMA IF NOT EXISTS shared;

-- Grant permissions
GRANT ALL PRIVILEGES ON SCHEMA dali_web TO dali;
GRANT ALL PRIVILEGES ON SCHEMA dali_edu TO dali;
GRANT ALL PRIVILEGES ON SCHEMA shared TO dali;

-- Set default privileges for future tables
ALTER DEFAULT PRIVILEGES IN SCHEMA dali_web GRANT ALL ON TABLES TO dali;
ALTER DEFAULT PRIVILEGES IN SCHEMA dali_edu GRANT ALL ON TABLES TO dali;
ALTER DEFAULT PRIVILEGES IN SCHEMA shared GRANT ALL ON TABLES TO dali;

-- Create a function to check database health
CREATE OR REPLACE FUNCTION shared.health_check()
RETURNS json AS $$
BEGIN
  RETURN json_build_object(
    'status', 'healthy',
    'timestamp', NOW(),
    'database', current_database(),
    'version', version()
  );
END;
$$ LANGUAGE plpgsql;

-- Log initialization
DO $$
BEGIN
  RAISE NOTICE 'DALI database initialized successfully';
  RAISE NOTICE 'Schemas created: dali_web, dali_edu, shared';
END $$;
