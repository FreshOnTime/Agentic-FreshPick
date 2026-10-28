import prisma from '@/lib/prisma';
import { beginConversationRun, boundedHistory, conversationDetail, deleteConversation, finishConversationRun, requestFingerprint } from '@/lib/agentic/conversations';
import type { Actor, AgentRequest } from '@/lib/agentic/contracts';

jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {
  $transaction: jest.fn(), $executeRaw: jest.fn(), agentConversation: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  agentRun: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  agentDraft: { findMany: jest.fn(), deleteMany: jest.fn() },
} }));
const db = prisma as unknown as {
  $transaction: jest.Mock; $executeRaw: jest.Mock;
  agentConversation: Record<'findFirst' | 'create' | 'update' | 'delete', jest.Mock>;
  agentRun: Record<'findUnique' | 'findFirst' | 'findMany' | 'count' | 'create' | 'update' | 'updateMany', jest.Mock>;
  agentDraft: Record<'findMany' | 'deleteMany', jest.Mock>;
};
const actor: Actor = { userId: 'customer', roles: ['customer'], supplierId: null };
const input: AgentRequest = { requestId: 'request1', mode: 'shopping', message: 'Fruit please', budget: 1000 };
beforeEach(() => {
  jest.resetAllMocks();
  db.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  db.agentRun.findUnique.mockResolvedValue(null); db.agentRun.count.mockResolvedValue(0);
  db.agentConversation.create.mockResolvedValue({ id: 'thread1' });
  db.agentRun.create.mockImplementation(async ({ data }) => ({ ...data, id: 'run1' }));
});
it('creates a conversation and scoped retry receipt atomically', async () => {
  expect(await beginConversationRun(actor, input)).toMatchObject({ replay: false, run: { conversationId: 'thread1', userId: actor.userId, requestText: input.message } });
  expect(db.$executeRaw).toHaveBeenCalled();
});
it('replays completed requests without consuming more quota or creating another run', async () => {
  db.agentRun.findUnique.mockResolvedValue({ status: 'completed', requestHash: requestFingerprint(input), responseText: 'A saved result' });
  expect(await beginConversationRun(actor, input)).toMatchObject({ replay: true });
  expect(db.agentRun.count).not.toHaveBeenCalled(); expect(db.agentRun.create).not.toHaveBeenCalled();
});
it('rejects changed payload reuse and active or failed retries', async () => {
  db.agentRun.findUnique.mockResolvedValue({ status: 'completed', requestHash: 'different' });
  await expect(beginConversationRun(actor, input)).rejects.toMatchObject({ code: 'REQUEST_CONFLICT' });
  db.agentRun.findUnique.mockResolvedValue({ status: 'running', requestHash: requestFingerprint(input), createdAt: new Date() });
  await expect(beginConversationRun(actor, input)).rejects.toMatchObject({ code: 'REQUEST_RUNNING' });
  db.agentRun.findUnique.mockResolvedValue({ status: 'failed', requestHash: requestFingerprint(input) });
  await expect(beginConversationRun(actor, input)).rejects.toMatchObject({ code: 'REQUEST_FAILED' });
});
it('scopes conversation lookup to owner and currently allowed modes', async () => {
  db.agentConversation.findFirst.mockResolvedValue(null);
  await expect(beginConversationRun(actor, { ...input, conversationId: 'other-thread' })).rejects.toThrow('not found');
  expect(db.agentConversation.findFirst).toHaveBeenCalledWith({ where: { id: 'other-thread', userId: actor.userId, mode: { in: ['shopping','procurement','support'] } } });
  await expect(conversationDetail(actor, 'other-thread')).rejects.toThrow('not found');
  await expect(deleteConversation(actor, 'other-thread')).rejects.toThrow('not found');
});
it('prevents changing modes or overlapping turns within a conversation', async () => {
  db.agentConversation.findFirst.mockResolvedValue({ id: 'thread1', mode: 'support' });
  await expect(beginConversationRun(actor, { ...input, conversationId: 'thread1' })).rejects.toThrow('change workspaces');
  db.agentConversation.findFirst.mockResolvedValue({ id: 'thread1', mode: 'shopping' }); db.agentRun.count.mockResolvedValue(1);
  await expect(beginConversationRun(actor, { ...input, conversationId: 'thread1' })).rejects.toMatchObject({ code: 'CONVERSATION_BUSY' });
  expect(db.agentRun.create).not.toHaveBeenCalled();
});
it('enforces the quota before creating a new conversation', async () => {
  db.agentRun.count.mockResolvedValue(20);
  await expect(beginConversationRun(actor, input)).rejects.toThrow('20 assistant requests');
  expect(db.agentConversation.create).not.toHaveBeenCalled();
});
it('bounds history, keeps complete pairs and restores chronological order', () => {
  const messages = boundedHistory(Array.from({ length: 12 }, (_, index) => ({ requestText: `question-${index}`, responseText: `answer-${index}` })));
  expect(messages).toHaveLength(16); expect(messages[0]).toEqual({ role: 'user', content: 'question-7' });
  expect(messages[15]).toEqual({ role: 'assistant', content: 'answer-0' });
  expect(boundedHistory([{ requestText: 'x'.repeat(24001), responseText: 'a' }])).toEqual([]);
});
it('erases conversation content but retains run receipts so deletion cannot reset quota', async () => {
  db.agentConversation.findFirst.mockResolvedValue({ id: 'thread1', mode: 'shopping' });
  await deleteConversation(actor, 'thread1');
  expect(db.agentRun.updateMany).toHaveBeenCalledWith({ where: { conversationId: 'thread1' }, data: { requestText: null, responseText: null, conversationId: null, status: 'deleted' } });
  expect(db.agentDraft.deleteMany).toHaveBeenCalled(); expect(db.agentConversation.delete).toHaveBeenCalled();
});
it('does not erase a live conversation or complete an expired worker', async () => {
  db.agentConversation.findFirst.mockResolvedValue({ id: 'thread1' }); db.agentRun.count.mockResolvedValue(1);
  await expect(deleteConversation(actor, 'thread1')).rejects.toThrow('Wait for the current');
  db.agentRun.findFirst.mockResolvedValue({ conversationId: 'thread1', createdAt: new Date(0) });
  await expect(finishConversationRun(actor, 'run1', 'Done', {}, [])).rejects.toMatchObject({ code: 'REQUEST_FAILED' });
  expect(db.agentConversation.delete).not.toHaveBeenCalled(); expect(db.agentRun.update).not.toHaveBeenCalled();
});
