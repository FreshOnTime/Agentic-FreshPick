import { NextRequest } from 'next/server';
import { POST, GET } from '@/app/api/agentic/route';
import { POST as confirm } from '@/app/api/agentic/drafts/[id]/confirm/route';
import { verifyToken } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { confirmDraft, startRun } from '@/lib/agentic/service';

jest.unmock('next/server');
jest.mock('ai', () => ({ ToolLoopAgent: jest.fn(), isStepCount: jest.fn() }));
jest.mock('@/lib/agentic/tools', () => ({ createAgentTools: jest.fn() }));
jest.mock('@/lib/agentic/service', () => ({ confirmDraft: jest.fn(), startRun: jest.fn() }));
jest.mock('@/lib/auth', () => ({ verifyToken: jest.fn() }));
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: { user: { findUniqueOrThrow: jest.fn() }, agentDraft: { findMany: jest.fn() } } }));

function request(body: unknown, origin = 'http://localhost:3000') {
  return new NextRequest('http://localhost:3000/api/agentic', { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}
beforeEach(() => {
  jest.resetAllMocks(); process.env.AGENTIC_ENABLED = 'true'; process.env.AI_GATEWAY_API_KEY = 'test-only'; process.env.AGENT_MODEL = 'test/model';
  (verifyToken as jest.Mock).mockResolvedValue({ userId: 'u1', role: 'customer', secondaryRoles: [] });
  (prisma.user.findUniqueOrThrow as jest.Mock).mockResolvedValue({ supplierId: null, supplier: null });
  (prisma.agentDraft.findMany as jest.Mock).mockResolvedValue([]);
});
it('rejects anonymous requests before model execution', async () => {
  (verifyToken as jest.Mock).mockResolvedValue(null);
  expect((await POST(request({ mode: 'shopping', message: 'Hello', budget: 1000 }))).status).toBe(401);
  expect(startRun).not.toHaveBeenCalled();
});
it('rejects cross-origin mutation and malformed payloads', async () => {
  expect((await POST(request({}, 'https://untrusted.example'))).status).toBe(403);
  expect((await POST(request({ mode: 'shopping', message: 'Hello', userId: 'other' }))).status).toBe(400);
  expect(startRun).not.toHaveBeenCalled();
});
it('enforces role access and requires an independently entered shopping budget', async () => {
  expect((await POST(request({ mode: 'inventory', message: 'Read stock' }))).status).toBe(403);
  expect((await POST(request({ mode: 'shopping', message: 'Build a basket' }))).status).toBe(400);
  expect(startRun).not.toHaveBeenCalled();
});
it('reports unavailable configuration instead of returning fabricated data', async () => {
  delete process.env.AI_GATEWAY_API_KEY;
  expect((await POST(request({ mode: 'shopping', message: 'Hello', budget: 1000 }))).status).toBe(503);
  expect(startRun).not.toHaveBeenCalled();
});
it('lists only this customer’s completed proposals with private cache headers', async () => {
  const response = await GET(new NextRequest('http://localhost:3000/api/agentic'));
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(prisma.agentDraft.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: 'u1', run: { status: 'completed' } }) }));
});
it('requires an explicit confirmation body before executing a draft', async () => {
  const context = { params: Promise.resolve({ id: '00000000-0000-4000-8000-000000000001' }) };
  expect((await confirm(request({ confirm: false }), context)).status).toBe(400);
  expect(confirmDraft).not.toHaveBeenCalled();
  (confirmDraft as jest.Mock).mockResolvedValue({ kind: 'basket', resultId: 'bag-1' });
  expect((await confirm(request({ confirm: true }), context)).status).toBe(200);
  expect(confirmDraft).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u1' }), '00000000-0000-4000-8000-000000000001');
});
