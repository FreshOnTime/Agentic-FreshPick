CREATE TABLE "agent_runs" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "mode" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'running', "inputTokens" INTEGER NOT NULL DEFAULT 0,
  "outputTokens" INTEGER NOT NULL DEFAULT 0, "toolNames" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "finishedAt" TIMESTAMP(3),
  CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "agent_runs_userId_createdAt_idx" ON "agent_runs"("userId", "createdAt");
CREATE TABLE "agent_drafts" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "runId" TEXT NOT NULL,
  "kind" TEXT NOT NULL, "title" TEXT NOT NULL, "payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending', "resultId" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "agent_drafts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "agent_drafts_runId_fkey" FOREIGN KEY ("runId") REFERENCES "agent_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "agent_drafts_userId_createdAt_idx" ON "agent_drafts"("userId", "createdAt");
CREATE INDEX "agent_drafts_runId_idx" ON "agent_drafts"("runId");
