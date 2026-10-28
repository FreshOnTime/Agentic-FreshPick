import { NextRequest } from 'next/server';
import { z } from 'zod';
import { AgentError } from '@/lib/agentic/contracts';
import { editDraft } from '@/lib/agentic/service';
import { agentActor, agentFailure, agentResponse, readAgentBody } from '@/lib/agentic/http';

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  try {
    const actor = await agentActor(request, true);
    const { id } = await context.params;
    if (!z.string().uuid().safeParse(id).success) throw new AgentError('Invalid draft ID.');
    return agentResponse(await editDraft(actor, id, await readAgentBody(request)));
  } catch (error) { return agentFailure(error); }
}
