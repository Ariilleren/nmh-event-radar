import 'dotenv/config';
import { spawnSync } from 'node:child_process';
const url=process.env.TEST_DATABASE_URL;
if(!url || !new URL(url).pathname.endsWith('_test')) throw new Error('TEST_DATABASE_URL должен указывать на отдельную БД с именем, оканчивающимся на _test.');
const env={...process.env,DATABASE_URL:url,AI_MODE:'DEMO'};
for(const args of [['node_modules/prisma/build/index.js','migrate','deploy'],['node_modules/vitest/vitest.mjs','run','tests/integration','--maxWorkers=1']]) {
  const child=spawnSync(process.execPath,args,{stdio:'inherit',env});
  if(child.status!==0) process.exit(child.status ?? 1);
}
