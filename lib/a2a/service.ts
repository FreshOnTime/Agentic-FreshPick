import { createHash, randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { Message, Role, Task, TaskState, SendMessageRequest, type ListTasksRequest, type ListTasksResponse } from '@a2a-js/sdk';
import { RequestMalformedError, TaskNotFoundError, TaskNotCancelableError, UnsupportedOperationError, ContentTypeNotSupportedError } from '@a2a-js/sdk/errors';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { basketInput, AgentError } from '@/lib/agentic/contracts';
import { quoteBasket } from '@/lib/agentic/service';
import { assertDeliveryArea, DeliveryPolicyError } from '@/lib/deliveryPolicy';

export const quotationInput = basketInput.extend({
  skill: z.literal('prepare_quote'),
  delivery: z.object({ city: z.string().trim().min(1).max(100), country: z.string().trim().min(1).max(100) }).strict(),
}).strict();
const identifier = z.string().min(1).max(128);
const uuid = z.string().uuid();
function invalid(message: string): never { throw new RequestMalformedError({ message }); }
function historyLength(value?: number) {
  if (value !== undefined && (!Number.isInteger(value) || value < 0 || value > 1000)) invalid('historyLength must be an integer from 0 to 1000.');
  return Math.min(value ?? 20, 20);
}
export function trimHistory(task: Task, limit?: number): Task {
  const length = historyLength(limit);
  return { ...task, history: length ? task.history.slice(-length) : [] };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
function hash(value: unknown) { return createHash('sha256').update(canonical(value)).digest('hex'); }
function json(value: unknown) { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }

/** Deterministic quotation skill. Prices and authority never depend on model output. */
export async function sendPartnerMessage(partnerId: string, params: SendMessageRequest): Promise<Task> {
  if (params.tenant) invalid('Tenant routing is not supported; identity comes from your bearer token.');
  const message = params.message;
  if (!message || message.role !== Role.ROLE_USER || !identifier.safeParse(message.messageId).success) invalid('A user message with a messageId (1–128 characters) is required.');
  if (message.taskId && !uuid.safeParse(message.taskId).success) invalid('taskId must be a UUID.');
  if (message.contextId && !uuid.safeParse(message.contextId).success) invalid('contextId must be a UUID returned by this agent.');
  if (message.referenceTaskIds.length || message.extensions.length) throw new UnsupportedOperationError({ message: 'Task references and extensions are not supported.' });
  if (!message.parts.length || message.parts.length > 4) invalid('Send 1–4 text/data parts.');
  if (message.parts.some(p => !p.content || !['text', 'data'].includes(p.content.$case))) throw new ContentTypeNotSupportedError({ message: 'Only text and JSON data are supported. File URLs are never fetched.' });
  if (message.parts.some(p => p.mediaType && p.mediaType !== (p.content?.$case === 'text' ? 'text/plain' : 'application/json'))) throw new ContentTypeNotSupportedError({ message: 'Use text/plain for text parts and application/json for quotation data.' });
  if (message.parts.some(p => p.content?.$case === 'text' && p.content.value.length > 4000)) invalid('Text is limited to 4,000 characters.');
  if (params.configuration?.taskPushNotificationConfig) throw new UnsupportedOperationError({ message: 'Push notifications are not supported.' });
  if (params.configuration?.returnImmediately) throw new UnsupportedOperationError({ message: 'This quotation skill completes within the request. Omit returnImmediately.' });
  const modes = params.configuration?.acceptedOutputModes || [];
  if (modes.length && !['application/json', 'text/plain'].every(m => modes.includes(m))) throw new ContentTypeNotSupportedError({ message: 'Accept both application/json and text/plain output.' });
  historyLength(params.configuration?.historyLength);
  const dataParts = message.parts.filter(p => p.content?.$case === 'data');
  if (dataParts.length > 1) invalid('Send one quotation data part.');
  const data = dataParts[0]?.content?.value;
  const parsed = quotationInput.safeParse(data);
  // Preserve the normalized wire request for exact, durable retry comparison.
  const requestHash = hash(SendMessageRequest.toJSON(params));
  const response = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`partner:${partnerId}`}))`;
    const receipt = await tx.partnerMessage.findUnique({ where: { partnerId_messageId: { partnerId, messageId: message.messageId } } });
    if (receipt) {
      if (receipt.requestHash !== requestHash) invalid('This messageId was already used for a different request. Use a new messageId.');
      return Task.fromJSON(receipt.response);
    }
    const count = await tx.partnerMessage.count({ where: { partnerId, createdAt: { gte: new Date(Date.now() - 3_600_000) } } });
    if (count >= 120) throw new UnsupportedOperationError({ message: 'The partner quota of 120 new messages per hour has been reached. Retry later.' });
    const existing = message.taskId ? await tx.partnerTask.findFirst({ where: { id: message.taskId, partnerId } }) : null;
    if (message.taskId && !existing) throw new TaskNotFoundError();
    if (existing && message.contextId && existing.contextId !== message.contextId) invalid('contextId does not match this task.');
    if (existing && existing.state !== TaskState.TASK_STATE_INPUT_REQUIRED) throw new UnsupportedOperationError({ message: 'This task is terminal. Start a new quotation with a new messageId and no taskId.' });
    if (!existing && message.contextId && !await tx.partnerTask.findFirst({ where: { partnerId, contextId: message.contextId }, select: { id: true } })) throw new TaskNotFoundError();
    const taskId = existing?.id || randomUUID();
    const contextId = existing?.contextId || message.contextId || randomUUID();
    const previous = existing ? Task.fromJSON(existing.payload) : undefined;
    const now = new Date();
    let state = TaskState.TASK_STATE_INPUT_REQUIRED;
    let explanation = 'Send a JSON data part with skill="prepare_quote", name, budget in LKR, items [{productId,quantity}], and delivery {city,country}. Quantities are whole catalog packs. Discover product IDs with the public MCP tools. No order is placed.';
    const artifacts: Task['artifacts'] = [];
    if (parsed.success) {
      try {
        assertDeliveryArea(parsed.data.delivery);
        const { name, budget, items } = parsed.data;
        const quote = await quoteBasket({ name, budget, items }, tx);
        const expiresAt = new Date(now.getTime() + 30 * 60_000).toISOString();
        state = TaskState.TASK_STATE_COMPLETED;
        explanation = 'Quotation prepared for review. This is not an order or stock reservation. Prices and availability must be checked again at checkout; delivery timing requires confirmation.';
        artifacts.push({ artifactId: randomUUID(), name: 'FreshPick quotation', description: explanation, extensions: [], metadata: undefined,
          parts: [{ content: { $case: 'data', value: { ...quote, currency: 'LKR', delivery: parsed.data.delivery,
            quotedAt: now.toISOString(), expiresAt, requiresHumanApproval: true, orderPlaced: false, stockReserved: false } }, mediaType: 'application/json', filename: '', metadata: undefined }] });
      } catch (error) {
        if (error instanceof AgentError || (error instanceof DeliveryPolicyError && error.status < 500)) explanation = `${error.message} Send revised quotation data with a new messageId and this taskId.`;
        else throw error; // Roll back on infrastructure failure; a retry can execute safely.
      }
    } else if (data !== undefined) {
      explanation += ` Correct these fields: ${[...new Set(parsed.error.issues.map(issue => issue.path.join('.') || 'request'))].slice(0, 12).join(', ')}.`;
    }
    const reply = Message.fromJSON({ messageId: randomUUID(), contextId, taskId, role: 'ROLE_AGENT', parts: [{ text: explanation, mediaType: 'text/plain' }] });
    const task: Task = { id: taskId, contextId, status: { state, timestamp: now.toISOString(), message: reply }, artifacts,
      history: [...(previous?.history || []), { ...message, contextId, taskId }, reply].slice(-20), metadata: undefined };
    const payload = json(Task.toJSON(task));
    await tx.partnerTask.upsert({ where: { id: taskId }, create: { id: taskId, partnerId, contextId, state, payload }, update: { state, payload } });
    await tx.partnerMessage.create({ data: { partnerId, messageId: message.messageId, requestHash, taskId, response: payload } });
    return task;
  }, { timeout: 15_000 });
  return trimHistory(response, params.configuration?.historyLength);
}

export async function getPartnerTask(partnerId: string, id: string, limit?: number): Promise<Task> {
  if (!uuid.safeParse(id).success) invalid('Task id must be a UUID.');
  historyLength(limit);
  const row = await prisma.partnerTask.findFirst({ where: { id, partnerId } });
  if (!row) throw new TaskNotFoundError();
  return trimHistory(Task.fromJSON(row.payload), limit);
}

export async function cancelPartnerTask(partnerId: string, id: string): Promise<Task> {
  if (!uuid.safeParse(id).success) invalid('Task id must be a UUID.');
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`partner:${partnerId}`}))`;
    const row = await tx.partnerTask.findFirst({ where: { id, partnerId } });
    if (!row) throw new TaskNotFoundError();
    const task = Task.fromJSON(row.payload);
    if (row.state === TaskState.TASK_STATE_CANCELED) return task;
    if (row.state !== TaskState.TASK_STATE_INPUT_REQUIRED) throw new TaskNotCancelableError();
    task.status = { state: TaskState.TASK_STATE_CANCELED, timestamp: new Date().toISOString(), message: undefined };
    await tx.partnerTask.update({ where: { id }, data: { state: TaskState.TASK_STATE_CANCELED, payload: json(Task.toJSON(task)) } });
    return task;
  });
}

export async function listPartnerTasks(partnerId: string, params: ListTasksRequest): Promise<ListTasksResponse> {
  const size = params.pageSize ?? 20;
  if (!Number.isInteger(size) || size < 1 || size > 100) invalid('pageSize must be 1–100.');
  historyLength(params.historyLength);
  if (params.contextId && !uuid.safeParse(params.contextId).success) invalid('Invalid contextId.');
  if (!Number.isInteger(params.status) || params.status < 0 || params.status > 8) invalid('Invalid task status.');
  if (params.statusTimestampAfter && !z.string().datetime({ offset: true }).safeParse(params.statusTimestampAfter).success) invalid('Invalid statusTimestampAfter.');
  const filter = hash({ partnerId, contextId: params.contextId, status: params.status, after: params.statusTimestampAfter || '' });
  let cursor: { id: string; createdAt: string } | undefined;
  if (params.pageToken) {
    try {
      if (params.pageToken.length > 1024) throw new Error();
      const token = z.object({ id: uuid, createdAt: z.string().datetime(), filter: z.literal(filter) }).strict().parse(JSON.parse(Buffer.from(params.pageToken, 'base64url').toString()));
      cursor = token;
    } catch { invalid('Invalid pageToken for these filters.'); }
  }
  const where: Prisma.PartnerTaskWhereInput = { partnerId,
    ...(params.contextId ? { contextId: params.contextId } : {}),
    ...(params.status ? { state: params.status } : {}),
    ...(params.statusTimestampAfter ? { updatedAt: { gte: new Date(params.statusTimestampAfter) } } : {}),
    ...(cursor ? { OR: [{ createdAt: { lt: new Date(cursor.createdAt) } }, { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } }] } : {}) };
  const rows = await prisma.partnerTask.findMany({ where, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: size + 1 });
  const page = rows.slice(0, size);
  const last = page.at(-1);
  return { tasks: page.map(row => ({ ...trimHistory(Task.fromJSON(row.payload), params.historyLength), artifacts: params.includeArtifacts ? Task.fromJSON(row.payload).artifacts : [] })),
    nextPageToken: rows.length > size && last ? Buffer.from(JSON.stringify({ id: last.id, createdAt: last.createdAt.toISOString(), filter })).toString('base64url') : '',
    pageSize: size, totalSize: await prisma.partnerTask.count({ where: { ...where, OR: undefined } }) };
}
