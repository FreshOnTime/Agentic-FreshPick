import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { SendMessageRequest, ListTasksRequest, TaskState, type Task } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory, DefaultAgentCardResolver } from '@a2a-js/sdk/client';
import prisma from '@/lib/prisma';
import { sendPartnerMessage, getPartnerTask, listPartnerTasks, cancelPartnerTask } from '@/lib/a2a/service';
import { consumeSharedRateLimit } from '@/lib/sharedRateLimit';
import { POST } from '@/app/api/a2a/route';
import { GET as card } from '@/app/.well-known/agent-card.json/route';

async function main() {
  const suffix = randomUUID();
  const partner = `test-${suffix}`, other = `other-${suffix}`;
  const product = await prisma.product.create({ data: { name: 'A2A mango pack', sku: suffix, slug: suffix, price: 200, discountPercentage: 10, stockQty: 10 } });
  const baselineOrders = await prisma.order.count();
  const baselineBags = await prisma.bag.count();
  const data = { skill: 'prepare_quote', name: 'Cafe fruit', budget: 1000, items: [{ productId: product.id, quantity: 2 }], delivery: { city: 'Colombo', country: 'Sri Lanka' } };
  const send = (value: unknown = data, taskId?: string) => SendMessageRequest.fromJSON({ message: { messageId: randomUUID(), taskId, role: 'ROLE_USER', parts: [{ data: value, mediaType: 'application/json' }] } });
  try {
    const params = send();
    const [a, b] = await Promise.all([sendPartnerMessage(partner, params), sendPartnerMessage(partner, params)]);
    assert.equal(a.id, b.id, 'concurrent exact requests must create one task');
    assert.equal(await prisma.partnerMessage.count({ where: { partnerId: partner } }), 1);
    assert.equal(a.status?.state, TaskState.TASK_STATE_COMPLETED);
    const quote = a.artifacts[0].parts[0].content?.value;
    assert.equal(quote.total, 460); assert.equal(quote.shipping, 100);
    assert.equal(quote.orderPlaced, false); assert.equal(quote.stockReserved, false);
    assert.equal(quote.requiresHumanApproval, true);
    assert.equal(Date.parse(quote.expiresAt) - Date.parse(quote.quotedAt), 30 * 60_000);
    assert.equal((await getPartnerTask(partner, a.id, 0)).history.length, 0);
    await assert.rejects(getPartnerTask(other, a.id), /not found/i);
    await assert.rejects(cancelPartnerTask(other, a.id), /not found/i);
    await assert.rejects(sendPartnerMessage(other, send(data, a.id)), /not found/i);
    await assert.rejects(cancelPartnerTask(partner, a.id), /cancel/i);
    const changed = send({ ...data, budget: 800 }); changed.message!.messageId = params.message!.messageId;
    await assert.rejects(sendPartnerMessage(partner, changed), /different request/);
    await prisma.product.update({ where: { id: product.id }, data: { price: 300 } });
    assert.equal((await sendPartnerMessage(partner, params)).artifacts[0].parts[0].content?.value.total, 460, 'retry must preserve original price and expiry');
    const fresh = await sendPartnerMessage(partner, send());
    assert.equal(fresh.artifacts[0].parts[0].content?.value.total, 640);

    const incomplete = await sendPartnerMessage(partner, send({ skill: 'prepare_quote' }));
    assert.equal(incomplete.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);
    const followed = await sendPartnerMessage(partner, send(data, incomplete.id));
    assert.equal(followed.id, incomplete.id); assert.equal(followed.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal(followed.history.length, 4);
    await assert.rejects(sendPartnerMessage(partner, send(data, followed.id)), /terminal/);
    const cancellable = await sendPartnerMessage(partner, send({}));
    assert.equal((await cancelPartnerTask(partner, cancellable.id)).status?.state, TaskState.TASK_STATE_CANCELED);
    assert.equal((await cancelPartnerTask(partner, cancellable.id)).id, cancellable.id);
    await assert.rejects(sendPartnerMessage(partner, send(data, cancellable.id)), /terminal/);
    for (const invalid of [{ ...data, budget: 1 }, { ...data, delivery: { city: 'London', country: 'UK' } }, { ...data, items: [{ productId: product.id, quantity: 100 }] }]) {
      assert.equal((await sendPartnerMessage(partner, send(invalid))).status?.state, TaskState.TASK_STATE_INPUT_REQUIRED);
    }
    const fileRequest = SendMessageRequest.fromJSON({ message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ url: 'https://example.test/private-file' }] } });
    await assert.rejects(sendPartnerMessage(partner, fileRequest), /text and JSON/);
    const roleRequest = send(); roleRequest.message!.role = 2;
    await assert.rejects(sendPartnerMessage(partner, roleRequest), /user message/);
    const negativeHistory = send(); negativeHistory.configuration = { acceptedOutputModes: [], returnImmediately: false, taskPushNotificationConfig: undefined, historyLength: -1 };
    await assert.rejects(sendPartnerMessage(partner, negativeHistory), /historyLength/);
    const otherTask = await sendPartnerMessage(other, send());
    const page = await listPartnerTasks(partner, ListTasksRequest.fromJSON({ pageSize: 2, historyLength: 0 }));
    assert.equal(page.tasks.length, 2); assert(page.nextPageToken);
    assert(page.tasks.every(task => !task.artifacts.length && !task.history.length && task.id !== otherTask.id));
    const nextPage = await listPartnerTasks(partner, ListTasksRequest.fromJSON({ pageSize: 2, pageToken: page.nextPageToken }));
    assert(!nextPage.tasks.some(task => page.tasks.some(previous => previous.id === task.id)));
    await assert.rejects(listPartnerTasks(other, ListTasksRequest.fromJSON({ pageToken: page.nextPageToken })), /pageToken/);
    const filtered = await listPartnerTasks(partner, ListTasksRequest.fromJSON({ status: 'TASK_STATE_COMPLETED', includeArtifacts: true }));
    assert(filtered.tasks.every(task => task.status?.state === TaskState.TASK_STATE_COMPLETED && task.artifacts.length === 1));

    // Exercise shared quota storage under concurrent workers and reset expiry.
    const namespace = `a2a_test_${suffix}`;
    const limits = await Promise.allSettled(Array.from({ length: 8 }, () => consumeSharedRateLimit(namespace, partner, 3)));
    assert.equal(limits.filter(result => result.status === 'fulfilled').length, 3);
    await prisma.apiRateBucket.updateMany({ where: { id: { startsWith: namespace } }, data: { resetAt: new Date(0) } });
    await consumeSharedRateLimit(namespace, partner, 3);

    // Real SDK client, real HTTP route and real PostgreSQL; only the network is in-process.
    const token = 'a'.repeat(43);
    process.env.A2A_ENABLED = 'true'; process.env.A2A_PUBLIC_URL = 'https://a2a-integration.example';
    process.env.A2A_PARTNERS = JSON.stringify([{ id: partner, tokenSha256: createHash('sha256').update(token).digest('hex') }]);
    const fetchImpl: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname === '/.well-known/agent-card.json') return card();
      request.headers.set('Authorization', `Bearer ${token}`);
      return POST(request);
    };
    const client = await new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl })], cardResolver: new DefaultAgentCardResolver({ fetchImpl }) }).createFromUrl(process.env.A2A_PUBLIC_URL);
    const result = await client.sendMessage(send()) as Task;
    assert.equal(result.status?.state, TaskState.TASK_STATE_COMPLETED);
    assert.equal(result.artifacts[0].parts[0].content?.value.total, 640);
    assert.equal(await prisma.order.count(), baselineOrders);
    assert.equal(await prisma.bag.count(), baselineBags);
    assert.equal((await prisma.product.findUniqueOrThrow({ where: { id: product.id } })).stockQty, 10);
    console.log('A2A PostgreSQL checks passed: official SDK → route → database, pricing, retries, ownership, follow-ups, cancellation, pagination, shared quota and no commerce mutations.');
  } finally {
    await prisma.partnerTask.deleteMany({ where: { partnerId: { in: [partner, other] } } });
    await prisma.apiRateBucket.deleteMany({ where: { OR: [{ id: { startsWith: `a2a_test_${suffix}` } }, { id: `a2a:${createHash('sha256').update(partner).digest('hex')}` }] } });
    await prisma.product.delete({ where: { id: product.id } });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
