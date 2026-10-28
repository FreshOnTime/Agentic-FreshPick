import { z } from 'zod';

export const modes = ['shopping', 'producer', 'inventory', 'procurement', 'support', 'growth'] as const;
export type AgentMode = typeof modes[number];
export const modeInfo: Record<AgentMode, { title: string; description: string; example: string }> = {
  shopping: { title: 'Build my basket', description: 'Find groceries and prepare a bag within your budget.', example: 'Build a varied fruit and vegetable basket for Rs. 3,500 including delivery. Use available products.' },
  producer: { title: 'Producer studio', description: 'Turn product details or a photo into a listing draft.', example: 'Draft a listing for my homemade mango chutney. Ask me for any missing ingredients, allergens, pack size and shelf life.' },
  inventory: { title: 'Stock & freshness', description: 'Review low stock and recorded sell-by dates.', example: 'Review low stock and products approaching their recorded sell-by date. Draft recommendations for my team.' },
  procurement: { title: 'Business purchasing', description: 'Match requirements to available catalog packs and draft an RFQ.', example: 'Help source tomatoes and onions for a cafe. Show available pack sizes, then ask how much I need before drafting an RFQ.' },
  support: { title: 'Order help', description: 'Check your orders and prepare a support request.', example: 'Show my recent orders and help me check the latest delivery status.' },
  growth: { title: 'Bundles & retention', description: 'Draft bundles and campaigns for a consented audience.', example: 'Suggest a seasonal bundle from the live catalog and draft an email campaign for opted-in subscribers.' },
};
export const requestSchema = z.object({
  mode: z.enum(modes),
  message: z.string().trim().min(1).max(4000),
  budget: z.number().positive().max(1_000_000).optional(),
  // Images are sent directly to the configured vision-capable model, never fetched by URL.
  image: z.string().max(2_800_000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/).optional(),
}).strict();
export const basketInput = z.object({
  name: z.string().trim().min(1).max(120),
  budget: z.number().positive().max(1_000_000),
  items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().positive().max(1000) }).strict()).min(1).max(40),
}).strict();
export type BasketInput = z.infer<typeof basketInput>;
export type BasketQuote = BasketInput & {
  lines: { productId: string; name: string; quantity: number; price: number; total: number; pack: string }[];
  subtotal: number; shipping: number; total: number;
};
export type DraftView = { id: string; kind: string; title: string; payload: unknown; status: string; expiresAt: string; resultId: string | null };

export class AgentError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
export type Actor = { userId: string; roles: string[]; supplierId: string | null };
export function allowedModes(actor: Actor): AgentMode[] {
  const result: AgentMode[] = ['shopping', 'procurement', 'support'];
  if (actor.roles.includes('admin') || (actor.roles.includes('supplier') && actor.supplierId)) result.push('producer');
  if (actor.roles.some(role => ['admin', 'inventory_manager'].includes(role))) result.push('inventory');
  if (actor.roles.some(role => ['admin', 'marketing_specialist'].includes(role))) result.push('growth');
  return result;
}
export function assertMode(actor: Actor, mode: AgentMode) {
  if (!allowedModes(actor).includes(mode)) throw new AgentError('Your account cannot use this workspace.', 403);
}
