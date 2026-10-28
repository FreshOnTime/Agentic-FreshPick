'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Loader2, Sparkles } from 'lucide-react';
import { authenticatedApiFetch } from '@/lib/api/authenticated-fetch';
import { modeInfo, type AgentMode, type ConversationView, type DraftView, type TurnView } from '@/lib/agentic/contracts';
import DraftCard from './DraftCard';

export default function AssistantWorkspace() {
  const [mode, setMode] = useState<AgentMode>('shopping');
  const [available, setAvailable] = useState<AgentMode[]>(['shopping', 'procurement', 'support']);
  const [message, setMessage] = useState(modeInfo.shopping.example);
  const [budget, setBudget] = useState('3500');
  const [photo, setPhoto] = useState<string>();
  const [photoName, setPhotoName] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string>();
  const [error, setError] = useState('');
  const [drafts, setDrafts] = useState<DraftView[]>([]);
  const [conversations, setConversations] = useState<ConversationView[]>([]);
  const [conversationId, setConversationId] = useState<string>();
  const [turns, setTurns] = useState<TurnView[]>([]);
  const controller = useRef<AbortController | null>(null);
  const pending = useRef<{ body: string; requestId: string } | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    void authenticatedApiFetch('/api/agentic', { signal: abort.signal }).then(async response => {
      const data = await response.json();
      if (response.status === 401) { setNeedsLogin(true); return; }
      if (!response.ok) throw new Error(data.error);
      setAvailable(data.modes); setEnabled(data.enabled); setDrafts(data.drafts); setConversations(data.conversations);
    }).catch(err => { if (!abort.signal.aborted) setError(err.message || 'Unable to load assistant.'); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => { abort.abort(); controller.current?.abort(); };
  }, []);

  function newConversation(next = mode) {
    setMode(next); setConversationId(undefined); setTurns([]); setDrafts([]);
    setMessage(modeInfo[next].example); setPhoto(undefined); setPhotoName(''); setError(''); pending.current = null;
  }
  async function loadConversation(id: string, updateBudget = true) {
    const response = await authenticatedApiFetch(`/api/agentic/conversations/${id}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to load conversation.');
    setConversationId(id); setMode(data.conversation.mode); setTurns(data.turns); setDrafts(data.drafts);
    setConversations(current => [data.conversation, ...current.filter(item => item.id !== id)].slice(0, 30));
    if (updateBudget) {
      const last = [...data.turns].reverse().find((turn: TurnView) => turn.budget !== null);
      if (last) setBudget(String(last.budget));
    }
  }
  async function resume(id: string) {
    setBusy(true); setError('');
    try { await loadConversation(id); setMessage(''); setPhoto(undefined); setPhotoName(''); pending.current = null; }
    catch (err) { setError(err instanceof Error ? err.message : 'Unable to load conversation.'); }
    finally { setBusy(false); }
  }
  async function removeConversation() {
    if (!conversationId || !window.confirm('Delete this conversation, its messages and proposals? Saved bags and submitted support cases will remain.')) return;
    setBusy(true); setError('');
    try {
      const response = await authenticatedApiFetch(`/api/agentic/conversations/${conversationId}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' } });
      const data = await response.json(); if (!response.ok) throw new Error(data.error);
      setConversations(current => current.filter(item => item.id !== conversationId)); newConversation();
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to delete conversation.'); }
    finally { setBusy(false); }
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    controller.current = new AbortController();
    const body = JSON.stringify({ mode, message, ...(conversationId ? { conversationId } : {}), ...(mode === 'shopping' ? { budget: Number(budget) } : {}), ...(photo ? { image: photo } : {}) });
    // Retain this ID after network failures so Retry retrieves the original run.
    if (!pending.current || pending.current.body !== body) pending.current = { body, requestId: crypto.randomUUID() };
    try {
      const response = await authenticatedApiFetch('/api/agentic', { method: 'POST', signal: controller.current.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...JSON.parse(body), requestId: pending.current.requestId }) });
      const data = await response.json();
      if (!response.ok) {
        if (data.code === 'REQUEST_FAILED') pending.current = null;
        throw new Error(data.error || 'Request failed.');
      }
      // Show the saved response even if the subsequent history read is unavailable.
      setConversationId(data.conversationId);
      setTurns(current => current.some(turn => turn.id === data.runId) ? current : [...current, { id: data.runId, requestText: message, responseText: data.text, status: 'completed', budget: mode === 'shopping' ? Number(budget) : null }]);
      setDrafts(current => [...data.drafts, ...current.filter(item => !data.drafts.some((draft: DraftView) => draft.id === item.id))].slice(0,30));
      setConversations(current => current.some(item => item.id === data.conversationId) ? current : [{ id: data.conversationId, mode, title: message.slice(0,100), updatedAt: new Date().toISOString() }, ...current].slice(0,30));
      pending.current = null; setMessage(''); setPhoto(undefined); setPhotoName('');
      try { await loadConversation(data.conversationId, false); } catch { setError('Your response was saved. Reopen this conversation to refresh its history.'); }
    } catch (err) { setError(err instanceof Error ? err.message : 'Request failed. Retry the unchanged message to retrieve its result.'); }
    finally { setBusy(false); }
  }
  async function confirm(draft: DraftView) {
    setConfirming(draft.id); setError('');
    try {
      const response = await authenticatedApiFetch(`/api/agentic/drafts/${draft.id}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Confirmation failed.');
      setDrafts(current => current.map(item => item.id === draft.id ? { ...item, status: 'confirmed', resultId: data.resultId } : item));
    } catch (err) { setError(err instanceof Error ? err.message : 'Confirmation failed.'); }
    finally { setConfirming(undefined); }
  }
  async function edit(draft: DraftView, action: 'dismiss' | 'revise', items?: { productId: string; quantity: number }[]) {
    setConfirming(draft.id); setError('');
    try {
      const response = await authenticatedApiFetch(`/api/agentic/drafts/${draft.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, ...(items ? { items } : {}) }) });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Unable to update proposal.');
      setDrafts(current => action === 'dismiss' ? current.filter(item => item.id !== draft.id) : current.map(item => item.id === draft.id ? data.draft : item));
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to update proposal.'); }
    finally { setConfirming(undefined); }
  }
  function uploadPhoto(file?: File) {
    setPhoto(undefined); setPhotoName('');
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 2_000_000) { setError('Choose a JPG, PNG or WebP photo smaller than 2 MB.'); return; }
    const reader = new FileReader();
    reader.onload = () => { setPhoto(String(reader.result)); setPhotoName(file.name); setError(''); };
    reader.onerror = () => setError('Unable to read this photo.'); reader.readAsDataURL(file);
  }
  const locked = busy || !!confirming;
  return <main className="editorial-wrap py-10 md:py-16">
    <div className="max-w-3xl">
      <p className="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-brand-green"><Sparkles size={16} aria-hidden="true" />FreshPick assistant</p>
      <h1 className="editorial-title text-4xl md:text-6xl">A little help.<br />A fresher everyday.</h1>
      <p className="mt-5 max-w-xl text-muted-foreground">Plan your groceries, refine a suggestion and pick up where you left off. Review every proposed action before it happens.</p>
    </div>
    {loading ? <p role="status" className="mt-10">Loading your workspace…</p> : needsLogin ? <div className="mt-10 rounded-2xl border border-border bg-secondary p-8">
      <h2 className="text-xl font-semibold">Your assistant, connected to your account.</h2><p className="my-3">Sign in to prepare bags and check your own orders.</p>
      <Link href="/auth/login?redirect=/assistant" className="editorial-button">Sign in</Link>
    </div> : <div className="mt-10 grid gap-8 lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className="min-w-0 space-y-5">
        <nav aria-label="Assistant workspaces" className="flex gap-2 overflow-x-auto lg:block lg:space-y-2">
          {available.map(key => <button key={key} type="button" disabled={locked} onClick={() => newConversation(key)} aria-pressed={mode === key}
            className={`min-h-12 shrink-0 rounded-xl border p-4 text-left lg:w-full ${mode === key ? 'border-brand-green bg-secondary text-brand-green' : 'border-border hover:bg-secondary'}`}>
            <span className="block text-sm font-semibold">{modeInfo[key].title}</span><span className="mt-1 hidden text-xs text-muted-foreground lg:block">{modeInfo[key].description}</span>
          </button>)}
        </nav>
        <div className="space-y-2 border-t border-border pt-4"><button type="button" disabled={locked} onClick={() => newConversation()} className="min-h-11 text-sm font-semibold text-brand-green">+ New conversation</button>
          <label htmlFor="assistant-history" className="block text-xs text-muted-foreground">Recent conversations</label>
          <select id="assistant-history" value={conversationId || ''} disabled={locked} onChange={e => e.target.value ? void resume(e.target.value) : newConversation()} className="h-12 w-full rounded-lg border border-border bg-background px-2 text-sm">
            <option value="">Start a new conversation</option>{conversations.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}
          </select>
          {conversationId && <button type="button" disabled={locked} onClick={() => void removeConversation()} className="min-h-11 text-xs text-muted-foreground underline">Delete this conversation</button>}
        </div>
      </aside>
      <div className="min-w-0 space-y-6">
        {!enabled && <p className="rounded-xl border border-border bg-secondary p-4 text-sm">The assistant is being prepared. You can still <Link className="underline" href="/products">browse the shop</Link> and use your saved bags.</p>}
        {!!turns.length && <section aria-label="Conversation history" aria-live="polite" className="max-h-[32rem] space-y-4 overflow-y-auto rounded-2xl border border-border p-5">
          {turns.map(turn => <div key={turn.id} className="space-y-3"><div className="ml-6 rounded-xl bg-secondary p-4"><p className="mb-1 text-xs font-semibold text-brand-green">You</p><p className="whitespace-pre-wrap break-words text-sm leading-6">{turn.requestText}</p></div>
            <div className="mr-6 p-3"><p className="mb-1 text-xs font-semibold text-brand-green">FreshPick</p><p className="whitespace-pre-wrap break-words text-sm leading-6">{turn.responseText || (turn.status === 'running' ? 'This request is still being processed or awaiting recovery.' : 'This request did not complete. You can send it again.')}</p></div></div>)}
        </section>}
        <form onSubmit={submit} className="space-y-4 rounded-2xl border border-border bg-card p-5 md:p-7">
          <label htmlFor="assistant-message" className="block text-lg font-semibold">{conversationId ? 'Continue the conversation' : modeInfo[mode].title}</label>
          <textarea id="assistant-message" value={message} onChange={e => setMessage(e.target.value)} disabled={locked} maxLength={4000} required rows={4} placeholder="For example: replace the bananas with another fruit."
            className="w-full rounded-xl border border-border bg-background p-4 text-base focus:outline-brand-green" />
          {mode === 'shopping' && <div><label htmlFor="assistant-budget" className="mb-2 block text-sm font-medium">Maximum total, including delivery (Rs.)</label>
            <input id="assistant-budget" type="number" min="1" max="1000000" step="0.01" required disabled={locked} value={budget} onChange={e => setBudget(e.target.value)} className="h-12 w-full rounded-lg border border-border bg-background px-4 sm:w-60" /></div>}
          {mode === 'producer' && <div><label htmlFor="assistant-photo" className="block text-sm font-medium">Optional product photo · maximum 2 MB</label>
            <input id="assistant-photo" type="file" accept="image/jpeg,image/png,image/webp" disabled={locked} onChange={e => uploadPhoto(e.target.files?.[0])} className="mt-2 max-w-full text-sm" />
            {photoName && <p className="mt-2 text-xs">Attached: {photoName} <button type="button" disabled={locked} onClick={() => { setPhoto(undefined); setPhotoName(''); }} className="underline">Remove</button></p>}</div>}
          <p className="text-xs text-muted-foreground">AI can make mistakes. Messages and proposals are saved to your account and relevant context is sent to our AI provider. You can delete a conversation. Recent messages are remembered; restate important older details. Photos are not retained for follow-ups.</p>
          <button type="submit" disabled={locked || !enabled} className="editorial-button disabled:cursor-not-allowed disabled:opacity-50">{busy ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Checking the details…</> : <>{conversationId ? 'Send follow-up' : 'Prepare my suggestion'} <ArrowUpRight className="ml-2 h-4 w-4" /></>}</button>
        </form>
        {error && <p role="alert" className="rounded-xl border border-destructive/30 p-4 text-sm text-destructive">{error}</p>}
        <section aria-label="Recent proposals" className="space-y-5">{drafts.map(draft => <DraftCard key={draft.id} draft={draft} confirming={locked ? (confirming || 'request-running') : undefined} onConfirm={() => void confirm(draft)} onEdit={(action, items) => void edit(draft, action, items)} />)}</section>
      </div>
    </div>}
  </main>;
}
