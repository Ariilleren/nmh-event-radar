import 'dotenv/config';
import { defineConfig } from '@playwright/test';
const database=process.env.TEST_DATABASE_URL;
if(!database || !new URL(database).pathname.endsWith('_test')) throw new Error('E2E требует отдельную TEST_DATABASE_URL с именем БД *_test.');
export default defineConfig({
  testDir:'tests/e2e',workers:1,fullyParallel:false,timeout:60000,
  use:{baseURL:'http://127.0.0.1:3100',trace:'retain-on-failure',screenshot:'only-on-failure',headless:true},
  webServer:{command:'node --import tsx scripts/e2e-server.ts',url:'http://127.0.0.1:3100/api/health',timeout:120000,reuseExistingServer:false,env:{DATABASE_URL:database,AI_MODE:'DEMO',NEXT_TELEMETRY_DISABLED:'1'}},
});
