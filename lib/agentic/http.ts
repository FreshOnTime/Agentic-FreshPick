import { NextRequest, NextResponse } from 'next/server';
import { verifyToken } from '@/lib/auth';
import prisma from '@/lib/prisma';
import { AgentError, type Actor } from './contracts';
import { DeliveryPolicyError } from '@/lib/deliveryPolicy';

export async function agentActor(request: NextRequest, mutation = false): Promise<Actor> {
  if (mutation) {
    const origin = request.headers.get('origin');
    const configured = process.env.FRONTEND_URL;
    if (!origin || (origin !== request.nextUrl.origin && origin !== configured)) throw new AgentError('Request origin is not allowed.', 403);
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new AgentError('JSON is required.', 415);
  }
  const identity = await verifyToken(request);
  if (!identity) throw new AgentError('Sign in to use the assistant.', 401);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: identity.userId },
    select: { supplierId: true, supplier: { select: { status: true, applicationStatus: true } } } });
  return { userId: identity.userId, roles: [identity.role, ...(identity.secondaryRoles || [])],
    supplierId: user.supplier?.status === 'active' && user.supplier.applicationStatus === 'approved' ? user.supplierId : null };
}
export async function readAgentBody(request: NextRequest) {
  // Enforce actual byte count, including chunked bodies; do not trust Content-Length.
  const reader = request.body?.getReader();
  if (!reader) throw new AgentError('Request body is required.');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 2_900_000) { await reader.cancel(); throw new AgentError('Request is too large.', 413); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AgentError('Invalid JSON request.'); }
}
export function agentResponse(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { 'Cache-Control': 'private, no-store' } });
}
export function agentFailure(error: unknown) {
  if (error instanceof DeliveryPolicyError) return agentResponse({ error: error.message }, error.status);
  if (error instanceof AgentError) return agentResponse({ error: error.message, ...(error.code ? { code: error.code } : {}) }, error.status);
  return agentResponse({ error: 'The assistant could not complete this request. Please try again.' }, 503);
}
