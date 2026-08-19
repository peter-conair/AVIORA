-- DropIndex
DROP INDEX "domain_events_processed_at_occurred_at_idx";

-- AlterTable
ALTER TABLE "domain_events" ADD COLUMN     "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateIndex
CREATE INDEX "domain_events_processed_at_next_attempt_at_idx" ON "domain_events"("processed_at", "next_attempt_at");
