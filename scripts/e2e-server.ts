import { spawnSync, spawn } from 'node:child_process';
// Isolated browser fixtures never contact Telegram or spend a real Groq quota.
process.env.RADAR_SYNC_ENABLED='false';
process.env.RADAR_DEMO_MODE='true';
if(!process.env.DATABASE_URL || !new URL(process.env.DATABASE_URL).pathname.endsWith('_test')) throw new Error('Refusing E2E on a non-test database');
const migrated=spawnSync(process.execPath,['node_modules/prisma/build/index.js','migrate','deploy'],{stdio:'inherit'});
if(migrated.status!==0) process.exit(1);
const {seedDemo}=await import('../src/server/workflow');
const {db}=await import('../src/server/db');
await db.$executeRaw`TRUNCATE TABLE "User", "Audit", "Task", "Assessment", "Analysis", "MessageVersion", "SourceMessage", "Event", "Location", "Company" CASCADE`;
await seedDemo('Подготовка E2E');
await db.$disconnect();
const server=spawn(process.execPath,['node_modules/next/dist/bin/next','start','--hostname','127.0.0.1','--port','3100'],{stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>{server.kill(signal);process.exit();});
server.on('exit',code=>process.exit(code ?? 0));
