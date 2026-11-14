ALTER TABLE "Location" ADD COLUMN "demoOrigin" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Location" SET "demoOrigin" = true WHERE "isDemo" = true;
