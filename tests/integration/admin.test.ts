import { afterAll, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from '../../src/app/api/[...path]/route';
import { db } from '../../src/server/db';

if (!process.env.DATABASE_URL || !new URL(process.env.DATABASE_URL).pathname.endsWith('_test')) {
  throw new Error('Admin integration tests require an isolated *_test database.');
}
afterAll(async () => { await db.$disconnect(); });
it('legacy state and source writes require an admin token; public health remains readable', async () => {
  const previous = process.env.OPERATIONS_ADMIN_TOKEN;
  process.env.OPERATIONS_ADMIN_TOKEN = 'integration-only-administrator';
  try {
    for (const authorization of [undefined, 'Bearer wrong', 'Bearer integration-only-administrat0r']) {
      const headers = authorization ? { authorization } : undefined;
      const state = await GET(new NextRequest('http://localhost:3000/api/state', { headers }), { params: Promise.resolve({ path: ['state'] }) });
      expect(state.status).toBe(403);
      expect((await state.json()).error.code).toBe('ADMIN_REQUIRED');
      const write = await POST(new NextRequest('http://localhost:3000/api/messages', { method: 'POST', headers, body: '{}' }), { params: Promise.resolve({ path: ['messages'] }) });
      expect(write.status).toBe(403);
    }
    const allowed = await POST(new NextRequest('http://localhost:3000/api/no-such-operation', {
      method: 'POST', headers: { authorization: 'Bearer integration-only-administrator' }, body: '{}',
    }), { params: Promise.resolve({ path: ['no-such-operation'] }) });
    expect(allowed.status).toBe(404);
    const health = await GET(new NextRequest('http://localhost:3000/api/health'), { params: Promise.resolve({ path: ['health'] }) });
    expect(health.status).toBe(200);
    delete process.env.OPERATIONS_ADMIN_TOKEN;
    const disabled = await GET(new NextRequest('http://localhost:3000/api/state'), { params: Promise.resolve({ path: ['state'] }) });
    expect(disabled.status).toBe(403);
  } finally {
    if (previous === undefined) delete process.env.OPERATIONS_ADMIN_TOKEN;
    else process.env.OPERATIONS_ADMIN_TOKEN = previous;
  }
});
