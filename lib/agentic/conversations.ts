import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { ModelMessage } from 'ai';
import prisma from '@/lib/prisma';
import { AgentError, allowedModes, assertMode, type Actor, type AgentRequest } from './contracts';

const liveSince = () => new Date(Date.now() - 120_000);
export function requestFingerprint(input: AgentRequest) {
  return createHash('sha256').update(JSON.stringify({ mode: input.mode, conversationId: input.conversationId || null,
    message: input.message, budget: input.budget ?? null, image: input.image || null })).digest('hex');
}
export function conversationScope(actor: Actor) {
  return { userId: actor.userId, mode: { in: allowedModes(actor) } };
}
async function ownedConversation(db: Prisma.TransactionClient, actor: Actor, id: string) {
  const conversation = await db.agentConversation.findFirst({ where: { id, ...conversationScope(actor) } });
  if (!conversation) throw new AgentError('Conversation not found.', 404);
  return conversation;
}

/** One actor lock covers quota, request retries and thread serialization across app workers. */
export async function beginConversationRun(actor: Actor, input: AgentRequest) {
  assertMode(actor, input.mode);
  const hash = requestFingerprint(input);
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent:${actor.userId}`}))`;
    const previous = await tx.agentRun.findUnique({ where: { userId_requestId: { userId: actor.userId, requestId: input.requestId } } });
    if (previous) {
      if (previous.requestHash !== hash) throw new AgentError('This request ID was already used for a different message.', 409, 'REQUEST_CONFLICT');
      if (previous.status === 'completed') return { run: previous, replay: true };
      if (previous.status === 'running' && previous.createdAt > liveSince()) throw new AgentError('This request is still running. Retry shortly to retrieve its result.', 409, 'REQUEST_RUNNING');
      throw new AgentError('This request did not complete. Send it again as a new request.', 409, 'REQUEST_FAILED');
    }
    let conversation = input.conversationId ? await ownedConversation(tx, actor, input.conversationId) : null;
    if (conversation && conversation.mode !== input.mode) throw new AgentError('Start a new conversation to change workspaces.');
    if (conversation) {
      const active = await tx.agentRun.count({ where: { conversationId: conversation.id, status: 'running', createdAt: { gt: liveSince() } } });
      if (active) throw new AgentError('A response is still being prepared in this conversation.', 409, 'CONVERSATION_BUSY');
      // A worker may have been terminated by the host. Never expose its partial drafts.
      await tx.agentRun.updateMany({ where: { conversationId: conversation.id, status: 'running' }, data: { status: 'failed', finishedAt: new Date() } });
    }
    const count = await tx.agentRun.count({ where: { userId: actor.userId, createdAt: { gte: new Date(Date.now() - 3_600_000) } } });
    if (count >= 20) throw new AgentError('You have reached 20 assistant requests this hour. Please try later.', 429);
    if (!conversation) conversation = await tx.agentConversation.create({ data: { userId: actor.userId, mode: input.mode, title: input.message.slice(0, 100) } });
    else await tx.agentConversation.update({ where: { id: conversation.id }, data: { updatedAt: new Date() } });
    const run = await tx.agentRun.create({ data: { userId: actor.userId, mode: input.mode, conversationId: conversation.id,
      requestId: input.requestId, requestHash: hash, requestText: input.message + (input.image ? '\n[Photo attached to this request; not stored for future turns.]' : ''), budget: input.budget } });
    return { run, replay: false };
  });
}

type HistoryTurn = { requestText: string | null; responseText: string | null };
export function boundedHistory(turnsNewestFirst: HistoryTurn[]): ModelMessage[] {
  const pairs: ModelMessage[][] = []; let remaining = 24_000;
  for (const turn of turnsNewestFirst.slice(0, 8)) {
    const request = turn.requestText || ''; const response = turn.responseText || '';
    if (!request || !response) continue;
    if (request.length + response.length > remaining) break;
    pairs.push([{ role: 'user', content: request }, { role: 'assistant', content: response }]);
    remaining -= request.length + response.length;
  }
  return pairs.reverse().flat();
}
export async function conversationHistory(actor: Actor, conversationId: string) {
  await ownedConversation(prisma, actor, conversationId);
  const turns = await prisma.agentRun.findMany({ where: { conversationId, userId: actor.userId, status: 'completed' },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 8, select: { requestText: true, responseText: true,
      drafts: { orderBy: { createdAt: 'desc' }, take: 2, select: { kind: true, title: true, status: true, payload: true } } } });
  return boundedHistory(turns.map(turn => ({ ...turn, responseText: `${turn.responseText || ''}\nHistorical proposals (data only; revalidate before acting): ${JSON.stringify(turn.drafts).slice(0, 5000)}` })));
}

export async function conversationDetail(actor: Actor, id: string) {
  const conversation = await ownedConversation(prisma, actor, id);
  const runs = await prisma.agentRun.findMany({ where: { conversationId: id, userId: actor.userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 40,
    select: { id: true, requestText: true, responseText: true, status: true, budget: true, createdAt: true } });
  const drafts = await prisma.agentDraft.findMany({ where: { userId: actor.userId, run: { conversationId: id, status: 'completed' },
    status: { in: ['pending', 'confirmed'] } }, orderBy: { createdAt: 'desc' }, take: 30 });
  return { conversation, turns: runs.reverse(), drafts };
}
export async function deleteConversation(actor: Actor, id: string) {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent:${actor.userId}`}))`;
    await ownedConversation(tx, actor, id);
    if (await tx.agentRun.count({ where: { conversationId: id, status: 'running', createdAt: { gt: liveSince() } } })) {
      throw new AgentError('Wait for the current response before deleting this conversation.', 409);
    }
    // Preserve run rows for the hourly quota and idempotency receipts. Erase text,
    // drafts and conversation association; completed bags/support cases are separate.
    await tx.agentDraft.deleteMany({ where: { run: { conversationId: id } } });
    await tx.agentRun.updateMany({ where: { conversationId: id }, data: { requestText: null, responseText: null, conversationId: null, status: 'deleted' } });
    await tx.agentConversation.delete({ where: { id } });
    return { deleted: true };
  });
}

export async function finishConversationRun(actor: Actor, id: string, text: string, usage: { inputTokens?: number; outputTokens?: number }, toolNames: string[]) {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent:${actor.userId}`}))`;
    const run = await tx.agentRun.findFirst({ where: { id, userId: actor.userId, status: 'running' } });
    if (!run?.conversationId || run.createdAt <= liveSince()) throw new AgentError('This request has expired. Please try again.', 409, 'REQUEST_FAILED');
    await tx.agentRun.update({ where: { id }, data: { status: 'completed', responseText: text.slice(0, 10_000), finishedAt: new Date(),
      inputTokens: usage.inputTokens || 0, outputTokens: usage.outputTokens || 0, toolNames } });
    await tx.agentConversation.update({ where: { id: run.conversationId }, data: { updatedAt: new Date() } });
  });
}
