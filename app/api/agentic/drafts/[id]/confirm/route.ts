import { NextRequest } from 'next/server';
import { z } from 'zod';
import { AgentError } from '@/lib/agentic/contracts';
import { agentActor, agentFailure, agentResponse, readAgentBody } from '@/lib/agentic/http';
import { confirmDraft } from '@/lib/agentic/service';

export async function POST(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await agentActor(request, true);
    const { id } = await context.params;
    if (!z.string().uuid().safeParse(id).success) throw new AgentError('Invalid draft ID.');
    if (!z.object({ confirm: z.literal(true) }).strict().safeParse(await readAgentBody(request)).success) throw new AgentError('Explicit confirmation is required.');
    return agentResponse(await confirmDraft(actor, id));
  } catch (error) { return agentFailure(error); }
}
