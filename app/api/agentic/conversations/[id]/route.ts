import { NextRequest } from 'next/server';
import { z } from 'zod';
import { AgentError } from '@/lib/agentic/contracts';
import { conversationDetail, deleteConversation } from '@/lib/agentic/conversations';
import { agentActor, agentFailure, agentResponse } from '@/lib/agentic/http';

type Context = { params: Promise<{ id: string }> };
async function idFrom(context: Context) {
  const { id } = await context.params;
  if (!z.string().uuid().safeParse(id).success) throw new AgentError('Invalid conversation ID.');
  return id;
}
export async function GET(request: NextRequest, context: Context) {
  try { return agentResponse(await conversationDetail(await agentActor(request), await idFrom(context))); }
  catch (error) { return agentFailure(error); }
}
export async function DELETE(request: NextRequest, context: Context) {
  try { return agentResponse(await deleteConversation(await agentActor(request, true), await idFrom(context))); }
  catch (error) { return agentFailure(error); }
}
