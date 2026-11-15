ALTER TABLE "SourceMessage" ADD COLUMN "channel" TEXT, ADD COLUMN "channelMessageId" TEXT;
CREATE UNIQUE INDEX "SourceMessage_channel_channelMessageId_key" ON "SourceMessage"("channel", "channelMessageId");
CREATE TABLE "SourceHealth" (
 "channel" TEXT PRIMARY KEY, "status" TEXT NOT NULL DEFAULT 'pending', "lastAttemptAt" TIMESTAMP(3), "lastSuccessAt" TIMESTAMP(3),
 "errorCode" TEXT, "errorMessage" TEXT, "fetched" INTEGER NOT NULL DEFAULT 0, "changed" INTEGER NOT NULL DEFAULT 0, "initialized" BOOLEAN NOT NULL DEFAULT false
);
CREATE TABLE "PersonalNewsAnalysis" (
 "id" TEXT PRIMARY KEY, "userId" TEXT NOT NULL, "messageId" TEXT NOT NULL, "contentHash" TEXT NOT NULL, "profileHash" TEXT NOT NULL,
 "status" TEXT NOT NULL DEFAULT 'pending', "result" JSONB, "errorCode" TEXT, "errorMessage" TEXT, "attempts" INTEGER NOT NULL DEFAULT 0,
 "retryAt" TIMESTAMP(3), "leaseUntil" TIMESTAMP(3), "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
 CONSTRAINT "PersonalNewsAnalysis_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT "PersonalNewsAnalysis_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "SourceMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "PersonalNewsAnalysis_userId_messageId_contentHash_profileHash_key" ON "PersonalNewsAnalysis"("userId", "messageId", "contentHash", "profileHash");
CREATE INDEX "PersonalNewsAnalysis_userId_status_idx" ON "PersonalNewsAnalysis"("userId", "status");
