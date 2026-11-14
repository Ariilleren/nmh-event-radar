import 'dotenv/config';
import { seedDemo } from '../src/server/workflow';
import { db } from '../src/server/db';
try { console.log(await seedDemo('Загрузчик демо', true)); }
finally { await db.$disconnect(); }
