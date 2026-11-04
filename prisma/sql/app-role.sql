-- Least-privilege database role for the running gateway (doc §5.10).
--
-- Two roles per environment:
--   * the OWNER (e.g. postgres) runs `prisma migrate deploy` from CI.
--   * gateway_app is what the app's DATABASE_URL uses in production.
--
-- Run as the owner AFTER migrations, once per environment, and again after
-- any migration that adds a table:
--   psql "$OWNER_DATABASE_URL" -v app_password="'<from the secret manager>'" -f prisma/sql/app-role.sql
--
-- What the app can NOT do with these grants:
--   * delete or rewrite payment history (PaymentTransition is append-only)
--   * edit a stored notification's body or headers (only its processing status)
--   * delete payments or events
-- So a bug or a compromised app server can't erase the audit trail.

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'gateway_app') THEN
    CREATE ROLE gateway_app LOGIN;
  END IF;
END
$$;
ALTER ROLE gateway_app PASSWORD :app_password;

GRANT USAGE ON SCHEMA public TO gateway_app;

-- Payments: create, read, change status. Never delete.
GRANT SELECT, INSERT, UPDATE ON "Payment" TO gateway_app;

-- Audit trail: append-only.
GRANT SELECT, INSERT ON "PaymentTransition" TO gateway_app;

-- Inbox: insert the raw notification; afterwards only its processing columns change.
GRANT SELECT, INSERT ON "ProviderNotification" TO gateway_app;
GRANT UPDATE ("processedAt", "error", "signatureValid", "paymentId", "providerRef")
  ON "ProviderNotification" TO gateway_app;

-- Outbox: insert, read, record delivery attempts. Never delete.
GRANT SELECT, INSERT, UPDATE ON "OutboxEvent" TO gateway_app;

-- Nonces: the cleanup job deletes expired ones.
GRANT SELECT, INSERT, DELETE ON "RequestNonce" TO gateway_app;

-- autoincrement ids (PaymentTransition, ProviderNotification)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gateway_app;

-- No grants on _prisma_migrations: the app never migrates.
