CREATE TABLE "partner_tasks" (
  "id" TEXT NOT NULL, "partnerId" TEXT NOT NULL, "contextId" TEXT NOT NULL,
  "state" INTEGER NOT NULL, "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "partner_tasks_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "partner_tasks_partnerId_createdAt_id_idx" ON "partner_tasks"("partnerId", "createdAt", "id");
CREATE INDEX "partner_tasks_partnerId_contextId_idx" ON "partner_tasks"("partnerId", "contextId");
CREATE TABLE "partner_messages" (
  "id" TEXT NOT NULL, "partnerId" TEXT NOT NULL, "messageId" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL, "taskId" TEXT NOT NULL, "response" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "partner_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "partner_messages_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "partner_tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "partner_messages_partnerId_messageId_key" ON "partner_messages"("partnerId", "messageId");
CREATE INDEX "partner_messages_createdAt_idx" ON "partner_messages"("createdAt");
CREATE TABLE "api_rate_buckets" (
  "id" TEXT NOT NULL, "count" INTEGER NOT NULL, "resetAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "api_rate_buckets_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "api_rate_buckets_resetAt_idx" ON "api_rate_buckets"("resetAt");
