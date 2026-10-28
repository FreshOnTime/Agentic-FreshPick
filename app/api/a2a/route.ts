import { JsonRpcTransportHandler, ServerCallContext, validateVersion } from '@a2a-js/sdk/server';
import { authenticatePartner, PartnerAuthError } from '@/lib/a2a/config';
import { quotationAgentCard } from '@/lib/a2a/card';
import { quotationHandler } from '@/lib/a2a/handler';
import { consumeSharedRateLimit, SharedRateLimitError } from '@/lib/sharedRateLimit';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
const respond = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, {
  status, headers: { 'Cache-Control': 'private, no-store', 'A2A-Version': '1.0', ...headers },
});
const failure = (status: number, message: string, headers = {}) => respond({ error: message }, status, headers);

export async function POST(request: Request) {
  try {
    const partnerId = authenticatePartner(request);
    if (!['application/json', 'application/a2a+json'].includes(request.headers.get('content-type')?.split(';')[0].trim() || '')) return failure(415, 'JSON is required.');
    await consumeSharedRateLimit('a2a', partnerId, 60);
    const reader = request.body?.getReader();
    if (!reader) return failure(400, 'A JSON-RPC request is required.');
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) { await reader.cancel(); return failure(413, 'Request exceeds 64 KiB.'); }
      chunks.push(value);
    }
    const raw = Buffer.concat(chunks).toString('utf8');
    // Match the protocol's absent-header default; this endpoint only advertises 1.0.
    const version = request.headers.get('a2a-version') || '0.3';
    const transport = new JsonRpcTransportHandler(quotationHandler(partnerId));
    const context = new ServerCallContext({ requestedVersion: version, user: { isAuthenticated: true, userName: partnerId } });
    let decoded: unknown;
    try { decoded = JSON.parse(raw); }
    catch { return respond({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON.' } }); }
    const parsed = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string().max(128), z.number().int(), z.null()]),
      method: z.string().min(1).max(100), params: z.record(z.unknown()).optional() }).strict().safeParse(decoded);
    if (!parsed.success) return respond({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'A single JSON-RPC request with an id is required.' } });
    const envelope = parsed.data;
    try { validateVersion(version, quotationAgentCard(), 'JSONRPC'); }
    catch (error) { return respond({ jsonrpc: '2.0', id: typeof envelope?.id === 'string' || typeof envelope?.id === 'number' ? envelope.id : null, error: JsonRpcTransportHandler.mapToJSONRPCError(error) }); }
    if (envelope?.params?.tenant) return respond({ jsonrpc: '2.0', id: envelope.id ?? null, error: { code: -32602, message: 'Tenant routing is not supported.' } });
    if (['SendStreamingMessage', 'SubscribeToTask'].includes(envelope.method)) return respond({ jsonrpc: '2.0', id: envelope.id, error: { code: -32004, message: 'Streaming is not supported.' } });
    const result = await transport.handle(raw, context);
    if (Symbol.asyncIterator in result) {
      // Streaming is explicitly not advertised. Consume only the SDK's immediate
      // unsupported-operation result; never leave a detached serverless task.
      const first = await result.next();
      await result.return(undefined);
      return respond(first.value);
    }
    // The SDK may serialize generic exceptions with their message. Keep database
    // and infrastructure details private on every internal-error response.
    if (result.error && (result.error as { code?: number }).code === -32603) result.error = { code: -32603, message: 'Quotation service unavailable. Retry with the same messageId.' };
    return respond(result);
  } catch (error) {
    if (error instanceof PartnerAuthError) return failure(error.status, error.message, error.status === 401 ? { 'WWW-Authenticate': 'Bearer realm="FreshPick partners"' } : {});
    if (error instanceof SharedRateLimitError) return failure(429, error.message, { 'Retry-After': String(error.retryAfter) });
    return failure(503, 'Quotation service unavailable. Retry with the same messageId.');
  }
}

export async function GET() { return failure(405, 'Use POST with an A2A JSON-RPC request.', { Allow: 'POST' }); }
