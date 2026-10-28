import type { Metadata } from 'next';
import AssistantWorkspace from '@/components/agentic/AssistantWorkspace';

export const metadata: Metadata = { title: 'Your FreshPick assistant', description: 'Plan groceries and review intelligent shopping suggestions.', robots: { index: false, follow: false } };
export default function AssistantPage() { return <AssistantWorkspace />; }
