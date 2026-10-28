import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import prisma from '@/lib/prisma';
import { confirmDraft, quoteBasket, saveDraft, startRun } from '@/lib/agentic/service';

async function main() {
  const suffix = randomUUID();
  const user = await prisma.user.create({ data: { firstName: 'Agent integration', email: `${suffix}@example.test` } });
  const other = await prisma.user.create({ data: { firstName: 'Other integration' } });
  const actor = { userId: user.id, roles: ['customer'], supplierId: null };
  const product = await prisma.product.create({ data: { name: 'Integration mango pack', sku: suffix, slug: suffix, price: 200, discountPercentage: 10, stockQty: 10 } });
  const input = { name: 'Integration bag', budget: 1000, items: [{ productId: product.id, quantity: 2 }] };
  try {
    const run = await startRun(actor, 'shopping');
    const quote = await quoteBasket(input);
    assert.equal(quote.total, 460);
    const draft = await saveDraft(actor, run.id, 'basket', input.name, quote);
    await assert.rejects(confirmDraft(actor, draft.id), /not completed/);
    await prisma.agentRun.update({ where: { id: run.id }, data: { status: 'completed' } });
    await assert.rejects(confirmDraft({ ...actor, userId: other.id }, draft.id), /not found/);

    // Competing transactions may serialize or one may fail with P2034. Both must
    // converge on a single receipt when the caller retries.
    const attempts = await Promise.allSettled([confirmDraft(actor, draft.id), confirmDraft(actor, draft.id)]);
    assert(attempts.some(result => result.status === 'fulfilled'), JSON.stringify(attempts.map(result => result.status === 'rejected' ? String(result.reason) : result.value)));
    const receipt = await confirmDraft(actor, draft.id);
    assert.equal(await prisma.bag.count({ where: { userId: user.id } }), 1);
    assert.equal((await prisma.bag.findUniqueOrThrow({ where: { id: receipt.resultId! } })).totalAmount.toNumber(), 360);
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stockQty, 10, 'saving a bag must not reserve stock');
    assert.equal(await prisma.auditLog.count({ where: { userId: user.id, action: 'agent_draft_confirmed' } }), 1);

    const stale = await saveDraft(actor, run.id, 'basket', input.name, quote);
    await prisma.product.update({ where: { id: product.id }, data: { price: 250 } });
    await assert.rejects(confirmDraft(actor, stale.id), /changed/);
    await prisma.product.update({ where: { id: product.id }, data: { stockQty: 0 } });
    await assert.rejects(confirmDraft(actor, stale.id), /unavailable/);
    assert.equal(await prisma.bag.count({ where: { userId: user.id } }), 1);

    const order = await prisma.order.create({ data: { customerId: user.id, orderNumber: suffix, subtotal: 100, total: 100, paymentMethod: 'cash', shippingAddress: {} } });
    const support = await saveDraft(actor, run.id, 'support', 'Order help', { orderId: order.id, subject: 'Order help', message: 'Please check the delivery.' });
    const caseReceipt = await confirmDraft(actor, support.id);
    const repeated = await confirmDraft(actor, support.id);
    assert.equal(caseReceipt.resultId, repeated.resultId);
    assert.equal(await prisma.contactEnquiry.count({ where: { submissionId: support.id } }), 1);

    // Check durable quota across concurrent requests, not process-local counters.
    await prisma.agentRun.createMany({ data: Array.from({ length: 18 }, () => ({ userId: user.id, mode: 'shopping', status: 'completed' })) });
    const quota = await Promise.allSettled([startRun(actor, 'shopping'), startRun(actor, 'shopping')]);
    assert.equal(quota.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(await prisma.agentRun.count({ where: { userId: user.id } }), 20);
    console.log('Agentic PostgreSQL integrity checks passed: quotes, ownership, completed runs, concurrent confirmation, receipts, audit, support and quota.');
  } finally {
    await prisma.contactEnquiry.deleteMany({ where: { email: user.email! } });
    await prisma.auditLog.deleteMany({ where: { userId: user.id } });
    await prisma.agentRun.deleteMany({ where: { userId: user.id } });
    await prisma.bagItem.deleteMany({ where: { bag: { userId: user.id } } });
    await prisma.bag.deleteMany({ where: { userId: user.id } });
    await prisma.order.deleteMany({ where: { customerId: user.id } });
    await prisma.product.delete({ where: { id: product.id } });
    await prisma.user.deleteMany({ where: { id: { in: [user.id, other.id] } } });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
