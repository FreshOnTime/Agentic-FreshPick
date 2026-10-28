import { Prisma } from '@prisma/client';
import prisma from '@/lib/prisma';
import { basketTotals, productUnitPrice } from '@/lib/commercePricing';
import { AgentError, assertMode, basketInput, draftEditSchema, type Actor, type AgentMode, type BasketInput, type BasketQuote } from './contracts';

type DB = Prisma.TransactionClient;
export const publicProductSelect = {
  id: true, name: true, slug: true, price: true, discountPercentage: true,
  stockQty: true, attributes: true, category: { select: { name: true } },
  supplier: { select: { name: true } },
} satisfies Prisma.ProductSelect;
export function packLabel(attributes: Prisma.JsonValue): string {
  const a = attributes && typeof attributes === 'object' && !Array.isArray(attributes) ? attributes : {};
  const quantity = a.baseMeasurementQuantity;
  const unit = a.measurementUnit;
  return quantity && unit ? `${quantity} ${unit}` : '1 catalog unit (pack size unverified)';
}
export async function quoteBasket(input: BasketInput, db: DB = prisma): Promise<BasketQuote> {
  const parsed = basketInput.parse(input);
  const merged = new Map<string, number>();
  for (const item of parsed.items) merged.set(item.productId, (merged.get(item.productId) || 0) + item.quantity);
  if ([...merged.values()].some(qty => qty > 1000)) throw new AgentError('Combined quantity exceeds 1,000 units.');
  const products = await db.product.findMany({ where: { id: { in: [...merged.keys()] }, archived: false }, select: publicProductSelect });
  const lines = [...merged].map(([productId, quantity]) => {
    const product = products.find(p => p.id === productId);
    if (!product || product.stockQty < quantity) throw new AgentError('A selected product is unavailable. Prepare a new basket.', 409);
    const price = productUnitPrice(product);
    return { productId, name: product.name, quantity, price, total: Math.round(price * 100) * quantity / 100, pack: packLabel(product.attributes) };
  });
  const totals = basketTotals(lines);
  if (Math.round(totals.total * 100) > Math.round(parsed.budget * 100)) throw new AgentError(`Basket including delivery is Rs. ${totals.total.toFixed(2)}, above the approved budget. Choose fewer or cheaper items.`);
  return { ...parsed, items: lines.map(({ productId, quantity }) => ({ productId, quantity })), lines, subtotal: totals.subtotal, shipping: totals.shipping, total: totals.total };
}
export async function saveDraft(actor: Actor, runId: string, kind: string, title: string, payload: unknown) {
  return prisma.agentDraft.create({ data: {
    userId: actor.userId, runId, kind, title,
    payload: JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue,
    expiresAt: new Date(Date.now() + 30 * 60_000),
  } });
}

/** All workers share a PostgreSQL advisory lock: quota cannot be bypassed by horizontal scaling. */
export async function startRun(actor: Actor, mode: string) {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent:${actor.userId}`}))`;
    const count = await tx.agentRun.count({ where: { userId: actor.userId, createdAt: { gte: new Date(Date.now() - 3_600_000) } } });
    if (count >= 20) throw new AgentError('You have reached 20 assistant requests this hour. Please try later.', 429);
    return tx.agentRun.create({ data: { userId: actor.userId, mode } });
  });
}

export async function confirmDraft(actor: Actor, id: string) {
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent:${actor.userId}`}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`draft:${id}`}))`;
    const draft = await tx.agentDraft.findFirst({ where: { id, userId: actor.userId }, include: { run: { select: { status: true } } } });
    if (!draft) throw new AgentError('Draft not found.', 404);
    if (draft.run.status !== 'completed') throw new AgentError('This assistant request has not completed successfully.', 409);
    if (draft.status === 'confirmed') return { kind: draft.kind, resultId: draft.resultId };
    if (draft.expiresAt < new Date()) throw new AgentError('This draft has expired. Prepare a new draft.', 409);
    if (draft.status !== 'pending') throw new AgentError('This draft is not available for confirmation.', 409);
    let resultId: string;
    if (draft.kind === 'basket') {
      const original = draft.payload as unknown as BasketQuote;
      const current = await quoteBasket(basketInput.parse({ name: original.name, budget: original.budget, items: original.items }), tx);
      // PostgreSQL JSONB normalizes object-key order. Compare quote values,
      // never serialization order, when deciding whether customer review is stale.
      const unchanged = current.lines.length === original.lines.length && current.lines.every((line, index) => {
        const previous = original.lines[index];
        return line.productId === previous.productId && line.quantity === previous.quantity &&
          line.price === previous.price && line.total === previous.total &&
          line.name === previous.name && line.pack === previous.pack;
      });
      if (!unchanged || current.shipping !== original.shipping || current.total !== original.total) {
        throw new AgentError('Prices, pack details or delivery fees changed. Prepare a new basket to review the latest quote.', 409);
      }
      const bag = await tx.bag.create({ data: {
        userId: actor.userId, name: current.name, tags: ['assistant'], totalAmount: current.subtotal,
        items: { create: current.lines.map(({ productId, quantity, price }) => ({ productId, quantity, price })) },
      } });
      resultId = bag.id;
    } else if (draft.kind === 'support') {
      const payload = draft.payload as { orderId: string; subject: string; message: string };
      const order = await tx.order.findFirst({ where: { id: payload.orderId, customerId: actor.userId }, select: { id: true } });
      const user = await tx.user.findUniqueOrThrow({ where: { id: actor.userId }, select: { email: true, firstName: true } });
      if (!order) throw new AgentError('Order not found.', 404);
      if (!user.email) throw new AgentError('Add an email to your profile before submitting a support case.');
      const enquiry = await tx.contactEnquiry.create({ data: { submissionId: draft.id, name: user.firstName.slice(0,100), email: user.email,
        subject: payload.subject, message: payload.message, orderId: order.id, source: 'support' } });
      resultId = enquiry.id;
    } else {
      throw new AgentError('This is a review-only proposal. Apply approved changes through the existing management workflow.');
    }
    await tx.agentDraft.update({ where: { id }, data: { status: 'confirmed', resultId } });
    await tx.auditLog.create({ data: { userId: actor.userId, action: 'agent_draft_confirmed', resourceType: draft.kind, resourceId: resultId, after: { draftId: id } } });
    return { kind: draft.kind, resultId };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function editDraft(actor: Actor, id: string, input: unknown) {
  const parsed = draftEditSchema.safeParse(input);
  if (!parsed.success) throw new AgentError('Select valid whole pack quantities, or dismiss this proposal.');
  return prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`agent:${actor.userId}`}))`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`draft:${id}`}))`;
    const draft = await tx.agentDraft.findFirst({ where: { id, userId: actor.userId }, include: { run: { select: { status: true, mode: true } } } });
    if (!draft) throw new AgentError('Draft not found.', 404);
    assertMode(actor, draft.run.mode as AgentMode);
    if (draft.run.status !== 'completed') throw new AgentError('This assistant request has not completed successfully.', 409);
    if (parsed.data.action === 'dismiss' && draft.status === 'dismissed') return { draft };
    if (draft.status !== 'pending') throw new AgentError('This proposal has already been confirmed, replaced or dismissed.', 409);
    if (parsed.data.action === 'dismiss') {
      return { draft: await tx.agentDraft.update({ where: { id }, data: { status: 'dismissed' } }) };
    }
    if (draft.kind !== 'basket') throw new AgentError('Only grocery baskets can be revised here.');
    const original = draft.payload as unknown as BasketQuote;
    const ids = new Set(original.items.map(item => item.productId));
    if (parsed.data.items.some(item => !ids.has(item.productId))) throw new AgentError('Ask the assistant to find a new product before adding it.');
    const quote = await quoteBasket({ name: original.name, budget: original.budget, items: parsed.data.items }, tx);
    const revision = await tx.agentDraft.create({ data: { userId: actor.userId, runId: draft.runId, kind: 'basket', title: draft.title,
      payload: JSON.parse(JSON.stringify(quote)) as Prisma.InputJsonValue, expiresAt: new Date(Date.now() + 30 * 60_000) } });
    await tx.agentDraft.update({ where: { id }, data: { status: 'superseded' } });
    return { draft: revision, replacedId: id };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}
