import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import prisma from '@/lib/prisma';
import { confirmDraft, editDraft, quoteBasket, saveDraft, startRun } from '@/lib/agentic/service';
import { beginConversationRun, conversationDetail, conversationHistory, deleteConversation, finishConversationRun } from '@/lib/agentic/conversations';

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

    // Exercise real JSONB storage, revisions and confirmation after customer edits.
    await prisma.product.update({ where: { id: product.id }, data: { price: 200, stockQty: 10 } });
    const editable = await saveDraft(actor, run.id, 'basket', input.name, quote);
    const revision = await editDraft(actor, editable.id, { action: 'revise', items: [{ productId: product.id, quantity: 1 }] });
    assert.equal((revision.draft.payload as { total: number }).total, 280);
    await assert.rejects(confirmDraft(actor, editable.id), /not available/);
    await confirmDraft(actor, revision.draft.id);
    assert.equal(await prisma.bag.count({ where: { userId: user.id } }), 2);
    const dismissible = await saveDraft(actor, run.id, 'basket', input.name, quote);
    await editDraft(actor, dismissible.id, { action: 'dismiss' });
    await assert.rejects(confirmDraft(actor, dismissible.id), /not available/);

    // A second account verifies owner isolation, retry receipts and memory.
    const threadActor = { ...actor, userId: other.id };
    const prompt = { requestId: randomUUID(), mode: 'shopping' as const, message: 'Fruit for two people', budget: 1000 };
    const started = await beginConversationRun(threadActor, prompt);
    const threadId = started.run.conversationId!;
    await assert.rejects(conversationDetail(actor, threadId), /not found/);
    await assert.rejects(deleteConversation(actor, threadId), /not found/);
    await assert.rejects(beginConversationRun(threadActor, prompt), /still running/);
    await assert.rejects(beginConversationRun(threadActor, { ...prompt, requestId: randomUUID(), conversationId: threadId }), /still being prepared/);
    await assert.rejects(deleteConversation(threadActor, threadId), /Wait for the current/);
    await finishConversationRun(threadActor, started.run.id, 'Which fruit would you like?', { inputTokens: 25, outputTokens: 10 }, []);
    const replay = await beginConversationRun(threadActor, prompt);
    assert.equal(replay.replay, true); assert.equal(replay.run.id, started.run.id);
    await assert.rejects(beginConversationRun(threadActor, { ...prompt, message: 'A different message' }), /different message/);
    const history = await conversationHistory(threadActor, threadId);
    assert.equal(history[0].content, prompt.message);
    assert.match(String(history[1].content), /Which fruit/);

    const nextPrompt = { ...prompt, requestId: randomUUID(), conversationId: threadId, message: 'Mangoes please' };
    const concurrentTurns = await Promise.allSettled([beginConversationRun(threadActor, nextPrompt), beginConversationRun(threadActor, { ...nextPrompt, requestId: randomUUID() })]);
    assert.equal(concurrentTurns.filter(result => result.status === 'fulfilled').length, 1);
    const followup = concurrentTurns.find(result => result.status === 'fulfilled');
    if (followup?.status !== 'fulfilled') throw new Error('No follow-up run created');
    await finishConversationRun(threadActor, followup.value.run.id, 'I can prepare mangoes.', {}, []);
    assert.equal((await conversationDetail(threadActor, threadId)).turns.length, 2);
    const retainedCount = await prisma.agentRun.count({ where: { userId: other.id } });
    await deleteConversation(threadActor, threadId);
    assert.equal(await prisma.agentConversation.count({ where: { id: threadId } }), 0);
    assert.equal(await prisma.agentRun.count({ where: { userId: other.id } }), retainedCount, 'deletion must not reset the request quota');
    const erased = await prisma.agentRun.findUniqueOrThrow({ where: { id: started.run.id } });
    assert.equal(erased.requestText, null); assert.equal(erased.responseText, null);
    await assert.rejects(beginConversationRun(threadActor, prompt), /did not complete/);

    // Check durable quota across concurrent requests, not process-local counters.
    await prisma.agentRun.createMany({ data: Array.from({ length: 18 }, () => ({ userId: user.id, mode: 'shopping', status: 'completed' })) });
    const quota = await Promise.allSettled([startRun(actor, 'shopping'), startRun(actor, 'shopping')]);
    assert.equal(quota.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(await prisma.agentRun.count({ where: { userId: user.id } }), 20);
    console.log('Agentic PostgreSQL integrity checks passed: quotes, ownership, concurrent confirmations and turns, retries, conversation memory/deletion, revisions, support and quota.');
  } finally {
    await prisma.contactEnquiry.deleteMany({ where: { email: user.email! } });
    await prisma.auditLog.deleteMany({ where: { userId: user.id } });
    await prisma.agentRun.deleteMany({ where: { userId: { in: [user.id, other.id] } } });
    await prisma.agentConversation.deleteMany({ where: { userId: { in: [user.id, other.id] } } });
    await prisma.bagItem.deleteMany({ where: { bag: { userId: user.id } } });
    await prisma.bag.deleteMany({ where: { userId: user.id } });
    await prisma.order.deleteMany({ where: { customerId: user.id } });
    await prisma.product.delete({ where: { id: product.id } });
    await prisma.user.deleteMany({ where: { id: { in: [user.id, other.id] } } });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
