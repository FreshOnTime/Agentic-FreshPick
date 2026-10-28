CREATE TABLE "agent_conversations" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "mode" TEXT NOT NULL,
  "title" VARCHAR(100) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "agent_conversations_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "agent_conversations_userId_updatedAt_idx" ON "agent_conversations"("userId", "updatedAt");
ALTER TABLE "agent_runs"
  ADD COLUMN "conversationId" TEXT,
  ADD COLUMN "requestId" TEXT,
  ADD COLUMN "requestHash" TEXT,
  ADD COLUMN "requestText" TEXT,
  ADD COLUMN "responseText" TEXT,
  ADD COLUMN "budget" DOUBLE PRECISION;
CREATE UNIQUE INDEX "agent_runs_userId_requestId_key" ON "agent_runs"("userId", "requestId");
CREATE INDEX "agent_runs_conversationId_createdAt_idx" ON "agent_runs"("conversationId", "createdAt");
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_conversationId_fkey"
  FOREIGN KEY ("conversationId") REFERENCES "agent_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
