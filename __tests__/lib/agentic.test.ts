import prisma from '@/lib/prisma';
import { allowedModes, assertMode, basketInput, type Actor } from '@/lib/agentic/contracts';
import { confirmDraft, editDraft, quoteBasket, startRun } from '@/lib/agentic/service';
import { createAgentTools } from '@/lib/agentic/tools';
import { enquirySources } from '@/lib/contactEnquiries';

jest.mock('ai', () => ({ tool: (value: unknown) => value }));
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {
  $transaction: jest.fn(), $executeRaw: jest.fn(), product: { findMany: jest.fn() },
  bag: { create: jest.fn() }, agentRun: { count: jest.fn(), create: jest.fn() },
  agentDraft: { findFirst: jest.fn(), update: jest.fn(), create: jest.fn() },
  auditLog: { create: jest.fn() }, order: { findFirst: jest.fn(), findMany: jest.fn() },
  user: { findUniqueOrThrow: jest.fn() }, contactEnquiry: { create: jest.fn() },
} }));

const mock = prisma as unknown as {
  $transaction: jest.Mock; $executeRaw: jest.Mock;
  product: { findMany: jest.Mock }; bag: { create: jest.Mock };
  agentRun: { count: jest.Mock; create: jest.Mock };
  agentDraft: { findFirst: jest.Mock; update: jest.Mock; create: jest.Mock };
  auditLog: { create: jest.Mock }; order: { findFirst: jest.Mock; findMany: jest.Mock };
  user: { findUniqueOrThrow: jest.Mock }; contactEnquiry: { create: jest.Mock };
};
const customer: Actor = { userId: 'customer-a', roles: ['customer'], supplierId: null };
const productId = '00000000-0000-4000-8000-000000000001';
const input = { name: 'Fruit bag', budget: 1000, items: [{ productId, quantity: 2 }] };
const product = { id: productId, name: 'Mangoes', price: 200, discountPercentage: 10, stockQty: 10, attributes: {} };
beforeEach(() => {
  jest.resetAllMocks();
  process.env.DELIVERY_FEE_LKR = '100'; delete process.env.DELIVERY_FREE_ABOVE_LKR; process.env.DELIVERY_MINIMUM_LKR = '0';
  mock.product.findMany.mockResolvedValue([product]);
  mock.$transaction.mockImplementation((fn: (db: typeof prisma) => unknown) => fn(prisma));
  mock.bag.create.mockResolvedValue({ id: 'bag-1' });
  mock.agentDraft.create.mockResolvedValue({ id: 'draft-1' });
});

it('prices with server promotions and includes delivery in the hard budget', async () => {
  expect(await quoteBasket(input)).toMatchObject({ subtotal: 360, shipping: 100, total: 460 });
  await expect(quoteBasket({ ...input, budget: 459.99 })).rejects.toThrow('above the approved budget');
});
it('merges duplicate product quantities before checking stock', async () => {
  await expect(quoteBasket({ ...input, items: [{ productId, quantity: 6 }, { productId, quantity: 6 }] })).rejects.toThrow('unavailable');
});
it('rejects absent products and invalid quantities', async () => {
  mock.product.findMany.mockResolvedValue([]);
  await expect(quoteBasket(input)).rejects.toThrow('unavailable');
  expect(basketInput.safeParse({ ...input, items: [{ productId, quantity: -1 }] }).success).toBe(false);
  expect(basketInput.safeParse({ ...input, items: [{ productId, quantity: 1.5 }] }).success).toBe(false);
});
it('cannot quote when delivery is not configured', async () => {
  delete process.env.DELIVERY_FEE_LKR;
  await expect(quoteBasket(input)).rejects.toThrow('not configured');
});
it('only permits approved supplier and authorized operational workspaces', () => {
  expect(allowedModes(customer)).toEqual(['shopping', 'procurement', 'support']);
  expect(() => assertMode(customer, 'inventory')).toThrow('cannot use');
  expect(allowedModes({ ...customer, roles: ['supplier'] })).not.toContain('producer');
  expect(allowedModes({ ...customer, roles: ['supplier'], supplierId: 'supplier-1' })).toContain('producer');
  expect(allowedModes({ ...customer, roles: ['customer', 'inventory_manager'] })).toContain('inventory');
});
it('does not register privileged tools for customers or allow mode escalation', () => {
  const tools = createAgentTools(customer, 'shopping', 'run-1', 1000);
  expect(tools.inventorySignals).toBeUndefined(); expect(tools.growthSignals).toBeUndefined();
  expect(tools.orderStatus).toBeUndefined(); expect(tools.confirmDraft).toBeUndefined();
  expect(() => createAgentTools(customer, 'growth', 'run-1')).toThrow();
});

async function runTool(mode: 'shopping' | 'support' | 'producer', name: string, args: unknown, actor = customer) {
  const tools = createAgentTools(actor, mode, 'run-1', 400);
  const execute = tools[name].execute as (input: unknown, options: unknown) => Promise<unknown>;
  return execute(args, { toolCallId: 'test', messages: [] });
}
it('uses the independently entered budget, not a model-supplied larger value', async () => {
  const result = await runTool('shopping', 'prepareBasket', { ...input, budget: 99999 });
  expect(result).toMatchObject({ error: expect.stringContaining('above the approved budget') });
  expect(mock.agentDraft.create).not.toHaveBeenCalled();
});
it('scopes all order lookup paths to the authenticated owner', async () => {
  mock.order.findFirst.mockResolvedValue(null);
  expect(await runTool('support', 'orderStatus', { reference: 'another-order' })).toEqual({ error: 'Order not found for this account.' });
  expect(mock.order.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ customerId: 'customer-a' }) }));
  await runTool('support', 'myOrders', {});
  expect(mock.order.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { customerId: 'customer-a' } }));
  await runTool('support', 'prepareSupportCase', { orderId: productId, subject: 'Help', message: 'Help me' });
  expect(mock.agentDraft.create).not.toHaveBeenCalled();
});
it('scopes producer catalog access to their linked supplier', async () => {
  await runTool('producer', 'searchProducts', { query: '' }, { ...customer, roles: ['supplier'], supplierId: 'supplier-1' });
  expect(mock.product.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ supplierId: 'supplier-1' }) }));
});
it('limits tool calls even when a model requests many in parallel', async () => {
  const tools = createAgentTools(customer, 'support', 'run-1');
  const execute = tools.myOrders.execute as (input: unknown, options: unknown) => Promise<unknown>;
  const results = await Promise.all(Array.from({ length: 30 }, () => execute({}, {})));
  expect(mock.order.findMany).toHaveBeenCalledTimes(16);
  expect(results[29]).toMatchObject({ error: expect.stringContaining('limit') });
});

async function pendingDraft() {
  const payload = await quoteBasket(input);
  return { id: 'draft-1', runId: 'run-1', title: 'Fruit bag', userId: customer.userId, status: 'pending', kind: 'basket', payload, expiresAt: new Date(Date.now() + 60_000), run: { status: 'completed', mode: 'shopping' } };
}
it('confirms a revalidated bag once and returns the receipt on retries', async () => {
  mock.agentDraft.findFirst.mockResolvedValue(await pendingDraft());
  expect(await confirmDraft(customer, 'draft-1')).toEqual({ kind: 'basket', resultId: 'bag-1' });
  expect(mock.bag.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ userId: customer.userId, totalAmount: 360 }) }));
  mock.agentDraft.findFirst.mockResolvedValue({ ...await pendingDraft(), status: 'confirmed', resultId: 'bag-1' });
  await confirmDraft(customer, 'draft-1'); expect(mock.bag.create).toHaveBeenCalledTimes(1);
});
it('rejects another owner, expired drafts and failed runs', async () => {
  mock.agentDraft.findFirst.mockResolvedValue(null);
  await expect(confirmDraft(customer, 'draft-1')).rejects.toThrow('not found');
  expect(mock.agentDraft.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'draft-1', userId: customer.userId } }));
  mock.agentDraft.findFirst.mockResolvedValue({ ...await pendingDraft(), expiresAt: new Date(0) });
  await expect(confirmDraft(customer, 'draft-1')).rejects.toThrow('expired');
  mock.agentDraft.findFirst.mockResolvedValue({ ...await pendingDraft(), run: { status: 'failed' } });
  await expect(confirmDraft(customer, 'draft-1')).rejects.toThrow('not completed');
  expect(mock.bag.create).not.toHaveBeenCalled();
});
it('accepts unchanged quotes after PostgreSQL JSONB reorders object keys', async () => {
  const draft = await pendingDraft();
  const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)])) : value;
  mock.agentDraft.findFirst.mockResolvedValue({ ...draft, payload: normalize(draft.payload) });
  await expect(confirmDraft(customer, draft.id)).resolves.toEqual({ kind: 'basket', resultId: 'bag-1' });
});
it('rejects changed prices or stock at confirmation without creating a bag', async () => {
  mock.agentDraft.findFirst.mockResolvedValue(await pendingDraft());
  mock.product.findMany.mockResolvedValue([{ ...product, price: 250 }]);
  await expect(confirmDraft(customer, 'draft-1')).rejects.toThrow('changed');
  mock.product.findMany.mockResolvedValue([{ ...product, stockQty: 0 }]);
  await expect(confirmDraft(customer, 'draft-1')).rejects.toThrow('unavailable');
  expect(mock.bag.create).not.toHaveBeenCalled();
});
it('does not execute review-only operational proposals', async () => {
  mock.agentDraft.findFirst.mockResolvedValue({ ...await pendingDraft(), kind: 'growth' });
  await expect(confirmDraft(customer, 'draft-1')).rejects.toThrow('review-only');
});
it('submits support drafts using a source supported by the existing inbox', async () => {
  mock.agentDraft.findFirst.mockResolvedValue({ ...await pendingDraft(), kind: 'support', payload: { orderId: 'order-1', subject: 'Order help', message: 'Please check delivery.' } });
  mock.order.findFirst.mockResolvedValue({ id: 'order-1' });
  mock.user.findUniqueOrThrow.mockResolvedValue({ firstName: 'Customer', email: 'customer@example.test' });
  mock.contactEnquiry.create.mockResolvedValue({ id: 'case-1' });
  expect(await confirmDraft(customer, 'draft-1')).toEqual({ kind: 'support', resultId: 'case-1' });
  expect(enquirySources).toContain(mock.contactEnquiry.create.mock.calls[0][0].data.source);
});
it('enforces a database-backed hourly quota before a model call', async () => {
  mock.agentRun.count.mockResolvedValue(20);
  await expect(startRun(customer, 'shopping')).rejects.toThrow('20 assistant requests');
  expect(mock.$executeRaw).toHaveBeenCalled(); expect(mock.agentRun.create).not.toHaveBeenCalled();
});
it('reprices edited quantities and supersedes the original without creating a bag', async () => {
  mock.agentDraft.findFirst.mockResolvedValue(await pendingDraft());
  mock.product.findMany.mockResolvedValue([{ ...product, price: 250 }]);
  mock.agentDraft.create.mockImplementation(async ({ data }) => ({ ...data, id: 'revision-1' }));
  const result = await editDraft(customer, 'draft-1', { action: 'revise', items: [{ productId, quantity: 1 }] });
  expect(result).toMatchObject({ replacedId: 'draft-1', draft: { payload: { total: 325, budget: 1000 } } });
  expect(mock.agentDraft.update).toHaveBeenCalledWith({ where: { id: 'draft-1' }, data: { status: 'superseded' } });
  expect(mock.bag.create).not.toHaveBeenCalled();
});
it('keeps the existing budget and original draft when revision validation fails', async () => {
  mock.agentDraft.findFirst.mockResolvedValue(await pendingDraft());
  await expect(editDraft(customer, 'draft-1', { action: 'revise', items: [{ productId, quantity: 10 }] })).rejects.toThrow('above the approved budget');
  await expect(editDraft(customer, 'draft-1', { action: 'revise', items: [{ productId: '00000000-0000-4000-8000-000000000002', quantity: 1 }] })).rejects.toThrow('new product');
  expect(mock.agentDraft.update).not.toHaveBeenCalled(); expect(mock.agentDraft.create).not.toHaveBeenCalled();
});
it('blocks editing other owners, already confirmed drafts and unauthorized workspaces', async () => {
  mock.agentDraft.findFirst.mockResolvedValue(null);
  await expect(editDraft(customer, 'draft-1', { action: 'dismiss' })).rejects.toThrow('not found');
  mock.agentDraft.findFirst.mockResolvedValue({ ...await pendingDraft(), status: 'confirmed' });
  await expect(editDraft(customer, 'draft-1', { action: 'dismiss' })).rejects.toThrow('already been');
  mock.agentDraft.findFirst.mockResolvedValue({ ...await pendingDraft(), run: { status: 'completed', mode: 'inventory' } });
  await expect(editDraft(customer, 'draft-1', { action: 'dismiss' })).rejects.toThrow('cannot use');
});
it('dismisses a proposal without business writes and rejects confirming it later', async () => {
  const draft = await pendingDraft();
  mock.agentDraft.findFirst.mockResolvedValue(draft);
  await editDraft(customer, draft.id, { action: 'dismiss' });
  expect(mock.agentDraft.update).toHaveBeenCalledWith({ where: { id: draft.id }, data: { status: 'dismissed' } });
  mock.agentDraft.findFirst.mockResolvedValue({ ...draft, status: 'dismissed' });
  await expect(confirmDraft(customer, draft.id)).rejects.toThrow('not available');
  expect(mock.bag.create).not.toHaveBeenCalled();
});
