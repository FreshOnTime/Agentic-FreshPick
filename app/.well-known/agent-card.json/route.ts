import { AgentCard } from '@a2a-js/sdk';
import { quotationAgentCard } from '@/lib/a2a/card';
import { requireA2aEnabled } from '@/lib/a2a/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET() {
  try {
    requireA2aEnabled();
    return Response.json(AgentCard.toJSON(quotationAgentCard()), { headers: { 'Cache-Control': 'no-store' } });
  } catch { return Response.json({ error: 'Partner quotations are not configured.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } }); }
}
