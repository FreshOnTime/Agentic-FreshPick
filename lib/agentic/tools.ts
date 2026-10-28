import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { productUnitPrice } from '@/lib/commercePricing';
import { deliveryPolicy } from '@/lib/deliveryPolicy';
import { assertMode, basketInput, type Actor, type AgentMode } from './contracts';
import { packLabel, publicProductSelect, quoteBasket, saveDraft } from './service';

const empty = z.object({}).strict();
const proposalSchema = z.object({
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(3000),
  recommendations: z.array(z.string().max(600)).max(12),
  missingInformation: z.array(z.string().max(300)).max(12),
}).strict();

export function createAgentTools(actor: Actor, mode: AgentMode, runId: string, budget?: number) {
  assertMode(actor, mode);
  // This closure is created from the verified DB identity, never from model arguments.
  let toolCalls = 0;
  const checked = <T, R>(execute: (input: T) => Promise<R>) => async (input: T) => {
    if (++toolCalls > 16) return { error: 'Tool call limit reached. Summarize the available results.' };
    try { return await execute(input); }
    catch (error) {
      // Business validation is recoverable; infrastructure failures must not leak internals.
      if (error instanceof Error && (error.name === 'AgentError' || 'status' in error)) return { error: error.message };
      return { error: 'This operation could not be completed. Do not claim it succeeded.' };
    }
  };
  const tools: ToolSet = {};
  if (mode !== 'support') {
    tools.searchProducts = tool({
      description: 'Search the live catalog using a short product/category phrase. Prices are LKR per catalog pack. Never infer kg from quantity. Empty query lists up to 25 products. Producer mode only returns your own products.',
      inputSchema: z.object({ query: z.string().max(100) }).strict(),
      execute: checked(async ({ query }: { query: string }) => {
        const products = await prisma.product.findMany({
          where: { archived: false,
            ...(mode === 'producer' && !actor.roles.includes('admin') ? { supplierId: actor.supplierId! } : {}),
            ...(query.trim() ? { OR: [{ name: { contains: query.trim(), mode: 'insensitive' as const } }, { category: { name: { contains: query.trim(), mode: 'insensitive' as const } } }] } : {}),
          }, select: publicProductSelect, orderBy: [{ stockQty: 'desc' }, { name: 'asc' }], take: 25,
        });
        return products.map(p => ({ id: p.id, name: p.name, price: productUnitPrice(p), availableUnits: p.stockQty,
          pack: packLabel(p.attributes), category: p.category?.name, producer: p.supplier?.name }));
      }),
    });
    tools.listCategories = tool({ description: 'List active catalog categories.', inputSchema: empty,
      execute: checked(async () => prisma.category.findMany({ where: { isActive: true }, select: { name: true }, take: 80 })) });
  }
  if (mode === 'shopping') {
    tools.deliveryPolicy = tool({ description: 'Read delivery fees, minimum order and supported cities. Availability is verified again at checkout.', inputSchema: empty,
      execute: checked(async () => deliveryPolicy()) });
    tools.prepareBasket = tool({
      description: 'Prepare a reviewable bag from exact product IDs and integer pack counts. Server verifies stock, discounts, delivery and the customer-entered total budget. This does not add to bags or place an order.',
      inputSchema: basketInput.omit({ budget: true }),
      execute: checked(async (input: Omit<z.infer<typeof basketInput>, 'budget'>) => {
        if (!budget) return { error: 'Ask the customer to set a basket budget.' };
        const quote = await quoteBasket({ ...input, budget });
        const draft = await saveDraft(actor, runId, 'basket', input.name, quote);
        return { draftId: draft.id, ...quote, requiresCustomerConfirmation: true };
      }),
    });
  }
  if (mode === 'support') {
    tools.myOrders = tool({ description: 'Read the signed-in customer’s ten latest orders. No access to other customers.', inputSchema: empty,
      execute: checked(async () => prisma.order.findMany({ where: { customerId: actor.userId }, take: 10, orderBy: { createdAt: 'desc' },
        select: { id: true, orderNumber: true, status: true, paymentStatus: true, estimatedDelivery: true, createdAt: true } })) });
    tools.orderStatus = tool({ description: 'Get an owned order by ID or order number. ETA is an estimate only.',
      inputSchema: z.object({ reference: z.string().min(1).max(100) }).strict(),
      execute: checked(async ({ reference }: { reference: string }) => {
        const order = await prisma.order.findFirst({ where: { customerId: actor.userId, OR: [{ id: reference }, { orderNumber: reference }] },
          select: { id: true, orderNumber: true, status: true, paymentStatus: true, estimatedDelivery: true, actualDelivery: true,
            items: { select: { name: true, qty: true } } } });
        return order || { error: 'Order not found for this account.' };
      }) });
    tools.prepareSupportCase = tool({ description: 'Draft a support request for the customer to review and submit to the existing enquiry inbox. Cannot cancel or refund.',
      inputSchema: z.object({ orderId: z.string().uuid(), subject: z.string().min(1).max(160), message: z.string().min(1).max(3000) }).strict(),
      execute: checked(async (input: { orderId: string; subject: string; message: string }) => {
        const order = await prisma.order.findFirst({ where: { id: input.orderId, customerId: actor.userId }, select: { id: true } });
        if (!order) return { error: 'Order not found for this account.' };
        const draft = await saveDraft(actor, runId, 'support', input.subject, input);
        return { draftId: draft.id, requiresCustomerConfirmation: true };
      }) });
  }
  if (mode === 'inventory') {
    tools.inventorySignals = tool({ description: 'Read up to 100 lowest-stock products and recorded product-level sellBy dates. No batch-level expiry or forecasting is available.', inputSchema: empty,
      execute: checked(async () => {
        const rows = await prisma.product.findMany({ where: { archived: false }, orderBy: { stockQty: 'asc' }, take: 100,
          select: { id: true, name: true, stockQty: true, minStockLevel: true, attributes: true } });
        return { coverage: '100 lowest-stock products; not a complete expiry sweep', products: rows.map(p => {
          const attrs = p.attributes as Record<string, unknown> | null;
          const date = typeof attrs?.sellBy === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(attrs.sellBy) ? attrs.sellBy : null;
          return { id: p.id, name: p.name, stock: p.stockQty, minimum: p.minStockLevel, lowStock: p.stockQty <= p.minStockLevel, recordedSellBy: date };
        }) };
      }) });
  }
  if (mode === 'growth') {
    tools.growthSignals = tool({ description: 'Get active email-consent count and aggregate purchased product quantities over 30 days. Contains no customer contact data; does not authorize sending.', inputSchema: empty,
      execute: checked(async () => ({
        optedInEmailSubscribers: await prisma.subscriber.count({ where: { isActive: true, unsubscribedAt: null } }),
        popularProducts: await prisma.orderItem.groupBy({ by: ['productId', 'name'], where: {
          order: { status: { in: ['confirmed', 'processing', 'shipped', 'delivered'] }, createdAt: { gte: new Date(Date.now() - 30 * 86400_000) } },
        }, _sum: { qty: true }, orderBy: { _sum: { qty: 'desc' } }, take: 10 }),
        whatsappConsentAvailable: false,
      })) });
  }
  if (['producer', 'inventory', 'procurement', 'growth'].includes(mode)) {
    tools.saveProposal = tool({ description: `Save a ${mode} proposal for human review. It does not publish, update stock, contact suppliers, place purchase orders or send campaigns. Include all missing information.`,
      inputSchema: proposalSchema, execute: checked(async (input: z.infer<typeof proposalSchema>) => {
        const draft = await saveDraft(actor, runId, mode, input.title, input);
        return { draftId: draft.id, reviewOnly: true };
      }) });
  }
  return tools;
}
