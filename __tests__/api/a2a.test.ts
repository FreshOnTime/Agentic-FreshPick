// Signing is not used: isolate the SDK's optional ESM JOSE import from Jest's CJS loader.
jest.mock(require.resolve('jose', { paths: [require.resolve('@a2a-js/sdk')] }), () => ({}));
jest.mock('@/lib/prisma', () => ({ __esModule: true, default: {} }));
jest.mock('@/lib/a2a/service', () => ({ sendPartnerMessage: jest.fn(), getPartnerTask: jest.fn(), listPartnerTasks: jest.fn(), cancelPartnerTask: jest.fn() }));
jest.mock('@/lib/sharedRateLimit', () => ({ ...jest.requireActual('@/lib/sharedRateLimit'), consumeSharedRateLimit: jest.fn() }));

import { createHash, randomUUID } from 'node:crypto';
import { Task, SendMessageRequest } from '@a2a-js/sdk';
import { ClientFactory, JsonRpcTransportFactory, DefaultAgentCardResolver } from '@a2a-js/sdk/client';
import { POST, GET } from '@/app/api/a2a/route';
import { GET as card } from '@/app/.well-known/agent-card.json/route';
import { sendPartnerMessage, getPartnerTask } from '@/lib/a2a/service';
import { authenticatePartner, a2aOrigin } from '@/lib/a2a/config';
import { consumeSharedRateLimit, SharedRateLimitError, publicClientIdentity } from '@/lib/sharedRateLimit';
import { TaskNotFoundError } from '@a2a-js/sdk/errors';

const token = 'a'.repeat(43);
const origin = 'https://freshpick-staging.example';
const taskId = randomUUID();
function request(body: unknown = { jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: taskId } }, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/a2a`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'A2A-Version': '1.0', ...headers }, body: JSON.stringify(body) });
}
const originalEnv = { ...process.env };
beforeEach(() => {
  jest.resetAllMocks();
  process.env.A2A_ENABLED = 'true';
  process.env.A2A_PUBLIC_URL = origin;
  process.env.A2A_PARTNERS = JSON.stringify([{ id: 'cafe', tokenSha256: createHash('sha256').update(token).digest('hex') }]);
  jest.mocked(consumeSharedRateLimit).mockResolvedValue(undefined);
  jest.mocked(sendPartnerMessage).mockResolvedValue(Task.fromJSON({ id: taskId, contextId: randomUUID(), status: { state: 'TASK_STATE_COMPLETED' } }));
});
afterAll(() => { process.env = originalEnv; });

describe('A2A HTTP adapter and official SDK interoperability', () => {
  it('advertises only implemented interfaces and never exposes partner credentials', async () => {
    const result = await card(); const body = await result.json();
    expect(result.status).toBe(200);
    expect(body.supportedInterfaces).toEqual([{ url: `${origin}/api/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }]);
    expect(body.capabilities.streaming).toBe(false);
    expect(body.securitySchemes.partnerToken.httpAuthSecurityScheme.scheme).toBe('bearer');
    expect(JSON.stringify(body)).not.toContain(createHash('sha256').update(token).digest('hex'));
  });
  it('fails closed when disabled or partner configuration is invalid', async () => {
    process.env.A2A_ENABLED = 'false';
    expect((await POST(request())).status).toBe(503);
    expect((await card()).status).toBe(503);
    process.env.A2A_ENABLED = 'true'; process.env.A2A_PARTNERS = '[]';
    expect((await POST(request())).status).toBe(503);
    expect(getPartnerTask).not.toHaveBeenCalled();
  });
  it('requires a valid partner token and returns a bearer challenge', async () => {
    for (const authorization of ['', 'Bearer wrong', `Bearer ${'b'.repeat(43)}`]) {
      const response = await POST(request(undefined, { authorization }));
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toContain('Bearer');
    }
    expect(consumeSharedRateLimit).not.toHaveBeenCalled();
    expect(authenticatePartner(request())).toBe('cafe');
  });
  it('rejects duplicate token mappings rather than assigning ambiguous ownership', () => {
    const entry = JSON.parse(process.env.A2A_PARTNERS!)[0];
    process.env.A2A_PARTNERS = JSON.stringify([entry, { ...entry, id: 'another' }]);
    expect(() => authenticatePartner(request())).toThrow('not configured');
  });
  it('does not derive the canonical origin from request headers', () => {
    process.env.A2A_PUBLIC_URL = 'https://example.test/path';
    expect(() => a2aOrigin()).toThrow();
    process.env.A2A_PUBLIC_URL = 'https://user:secret@example.test';
    expect(() => a2aOrigin()).toThrow();
  });
  it('rejects unsupported protocol versions and methods', async () => {
    for (const version of ['0.3', '9.0']) {
      const body = await (await POST(request(undefined, { 'A2A-Version': version }))).json();
      expect(body.error.code).toBe(-32009);
    }
    for (const method of ['SendStreamingMessage', 'SubscribeToTask']) {
      const body = await (await POST(request({ jsonrpc: '2.0', id: 1, method, params: {} }))).json();
      expect(body.error.code).toBe(-32004);
    }
    expect(getPartnerTask).not.toHaveBeenCalled();
  });
  it('rejects invalid envelopes, tenant routing and oversized bodies', async () => {
    for (const body of [null, [], {}, { jsonrpc: '2.0', method: 'SendMessage', params: {} }]) {
      expect((await (await POST(request(body))).json()).error.code).toBe(-32600);
    }
    const tenant = await POST(request({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: taskId, tenant: 'other' } }));
    expect((await tenant.json()).error.code).toBe(-32602);
    expect((await POST(request({ data: 'x'.repeat(70000) }))).status).toBe(413);
    expect((await POST(request({}, { 'content-type': 'text/plain' }))).status).toBe(415);
    expect((await GET()).status).toBe(405);
  });
  it('preserves task-not-found without exposing database errors', async () => {
    jest.mocked(getPartnerTask).mockRejectedValueOnce(new TaskNotFoundError());
    expect((await (await POST(request())).json()).error.code).toBe(-32001);
    expect(getPartnerTask).toHaveBeenCalledWith('cafe', taskId, undefined);
    jest.mocked(getPartnerTask).mockRejectedValueOnce(new Error('postgres password-secret'));
    const body = await (await POST(request())).json();
    expect(body.error.code).toBe(-32603);
    expect(JSON.stringify(body)).not.toContain('password-secret');
  });
  it('returns shared rate-limit headers and fails closed on storage failure', async () => {
    jest.mocked(consumeSharedRateLimit).mockRejectedValueOnce(new SharedRateLimitError(23));
    const response = await POST(request());
    expect(response.status).toBe(429); expect(response.headers.get('Retry-After')).toBe('23');
    jest.mocked(consumeSharedRateLimit).mockRejectedValueOnce(new Error('private DB error'));
    expect((await POST(request())).status).toBe(503);
  });
  it('uses only the active hosting provider ingress identity for public quotas', () => {
    delete process.env.VERCEL; delete process.env.NETLIFY;
    const r = request({}, { 'x-forwarded-for': '192.0.2.1', 'x-nf-client-connection-ip': '192.0.2.2' });
    expect(publicClientIdentity(r)).toBe('unknown');
    process.env.VERCEL = '1'; expect(publicClientIdentity(r)).toBe('192.0.2.1');
    delete process.env.VERCEL; process.env.NETLIFY = 'true'; expect(publicClientIdentity(r)).toBe('192.0.2.2');
    delete process.env.NETLIFY;
  });
  it('lets the official SDK discover the card and send a typed request through the HTTP route', async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const r = new Request(input, init);
      if (new URL(r.url).pathname === '/.well-known/agent-card.json') return card();
      r.headers.set('Authorization', `Bearer ${token}`);
      return POST(r);
    };
    const client = await new ClientFactory({ transports: [new JsonRpcTransportFactory({ fetchImpl })], cardResolver: new DefaultAgentCardResolver({ fetchImpl }) }).createFromUrl(origin);
    const result = await client.sendMessage(SendMessageRequest.fromJSON({ message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text: 'Prepare a quote' }] } }));
    expect(result).toHaveProperty('id', taskId);
    expect(sendPartnerMessage).toHaveBeenCalledWith('cafe', expect.objectContaining({ message: expect.objectContaining({ role: 1 }) }));
  });
});
