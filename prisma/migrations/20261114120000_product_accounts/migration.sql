CREATE TABLE "User" (
  "id" TEXT NOT NULL, "email" TEXT NOT NULL, "passwordHash" TEXT NOT NULL,
  "name" TEXT NOT NULL, "photo" TEXT, "businessName" TEXT NOT NULL DEFAULT '',
  "businessType" TEXT NOT NULL DEFAULT '', "city" TEXT NOT NULL DEFAULT '',
  "about" TEXT NOT NULL DEFAULT '', "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE TABLE "Session" (
  "tokenHash" TEXT NOT NULL, "userId" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Session_pkey" PRIMARY KEY ("tokenHash"),
  CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");
CREATE TABLE "UserLocation" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "locationId" TEXT NOT NULL, "profile" JSONB NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "UserLocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UserLocation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "UserLocation_userId_locationId_key" ON "UserLocation"("userId","locationId");
CREATE TABLE "EventFeedback" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "eventId" TEXT NOT NULL, "value" INTEGER NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL, CONSTRAINT "EventFeedback_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "EventFeedback_value_check" CHECK ("value" IN (-1,1)),
  CONSTRAINT "EventFeedback_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "EventFeedback_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "EventFeedback_userId_eventId_key" ON "EventFeedback"("userId","eventId");
CREATE TABLE "UserNotification" (
  "id" TEXT NOT NULL, "userId" TEXT NOT NULL, "eventId" TEXT NOT NULL, "eventVersion" INTEGER NOT NULL,
  "title" TEXT NOT NULL, "body" TEXT NOT NULL, "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "UserNotification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UserNotification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "UserNotification_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "UserNotification_userId_eventId_eventVersion_key" ON "UserNotification"("userId","eventId","eventVersion");
CREATE INDEX "UserNotification_userId_readAt_idx" ON "UserNotification"("userId","readAt");
