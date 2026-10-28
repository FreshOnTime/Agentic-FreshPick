'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { ArrowUpRight, Check, Loader2, Sparkles } from 'lucide-react';
import { authenticatedApiFetch } from '@/lib/api/authenticated-fetch';
import { modeInfo, type AgentMode, type BasketQuote, type DraftView } from '@/lib/agentic/contracts';

const money = (value: number) => new Intl.NumberFormat('en-LK', { style: 'currency', currency: 'LKR' }).format(value);
type Proposal = { summary: string; recommendations: string[]; missingInformation: string[] };
const reviewLinks: Partial<Record<string, { href: string; label: string }>> = {
  producer: { href: '/dashboard', label: 'Producer portal' }, inventory: { href: '/admin/products', label: 'Product management' },
  procurement: { href: '/b2b', label: 'Business enquiries' }, growth: { href: '/admin/newsletter', label: 'Newsletter management' },
};

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
  const [reply, setReply] = useState('');
  const [drafts, setDrafts] = useState<DraftView[]>([]);
  const controller = useRef<AbortController | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    void authenticatedApiFetch('/api/agentic', { signal: abort.signal }).then(async response => {
      const data = await response.json();
      if (response.status === 401) { setNeedsLogin(true); return; }
      if (!response.ok) throw new Error(data.error);
      setAvailable(data.modes); setEnabled(data.enabled); setDrafts(data.drafts);
    }).catch(err => { if (!abort.signal.aborted) setError(err.message || 'Unable to load assistant.'); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => { abort.abort(); controller.current?.abort(); };
  }, []);

  function selectMode(next: AgentMode) {
    setMode(next); setMessage(modeInfo[next].example); setPhoto(undefined); setPhotoName(''); setReply(''); setError('');
  }
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError(''); setReply('');
    controller.current = new AbortController();
    try {
      const response = await authenticatedApiFetch('/api/agentic', { method: 'POST', signal: controller.current.signal,
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode, message, ...(mode === 'shopping' ? { budget: Number(budget) } : {}), ...(photo ? { image: photo } : {}) }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Request failed.');
      setReply(data.text); setDrafts(current => [...data.drafts, ...current].slice(0, 20));
    } catch (err) { setError(err instanceof Error ? err.message : 'Request failed.'); }
    finally { setBusy(false); }
  }
  async function confirm(draft: DraftView) {
    setConfirming(draft.id); setError('');
    try {
      const response = await authenticatedApiFetch(`/api/agentic/drafts/${draft.id}/confirm`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Confirmation failed.');
      setDrafts(current => current.map(item => item.id === draft.id ? { ...item, status: 'confirmed', resultId: data.resultId } : item));
    } catch (err) { setError(err instanceof Error ? err.message : 'Confirmation failed.'); }
    finally { setConfirming(undefined); }
  }
  async function uploadPhoto(file?: File) {
    setPhoto(undefined); setPhotoName('');
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) || file.size > 2_000_000) {
      setError('Choose a JPG, PNG or WebP photo smaller than 2 MB.'); return;
    }
    const reader = new FileReader();
    reader.onload = () => { setPhoto(String(reader.result)); setPhotoName(file.name); setError(''); };
    reader.onerror = () => setError('Unable to read this photo.');
    reader.readAsDataURL(file);
  }

  return <main className="editorial-wrap py-10 md:py-16">
    <div className="max-w-3xl">
      <p className="mb-4 flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-brand-green"><Sparkles size={16} aria-hidden="true" />FreshPick assistant</p>
      <h1 className="editorial-title text-4xl md:text-6xl">A little help.<br />A fresher everyday.</h1>
      <p className="mt-5 max-w-xl text-muted-foreground">Plan your groceries, find what you need and get help with your orders. Review every proposed action before it happens.</p>
    </div>
    {loading ? <p role="status" className="mt-10">Loading your workspace…</p> : needsLogin ? <div className="mt-10 rounded-2xl border border-border bg-secondary p-8">
      <h2 className="text-xl font-semibold">Your assistant, connected to your account.</h2><p className="my-3">Sign in to prepare bags and check your own orders.</p>
      <Link href="/auth/login?redirect=/assistant" className="editorial-button">Sign in</Link>
    </div> : <div className="mt-10 grid gap-8 lg:grid-cols-[240px_minmax(0,1fr)]">
      <nav aria-label="Assistant workspaces" className="flex gap-2 overflow-x-auto lg:block lg:space-y-2">
        {available.map(key => <button key={key} type="button" disabled={busy} onClick={() => selectMode(key)} aria-pressed={mode === key}
          className={`min-h-12 shrink-0 rounded-xl border p-4 text-left lg:w-full ${mode === key ? 'border-brand-green bg-secondary text-brand-green' : 'border-border hover:bg-secondary'}`}>
          <span className="block text-sm font-semibold">{modeInfo[key].title}</span><span className="mt-1 hidden text-xs text-muted-foreground lg:block">{modeInfo[key].description}</span>
        </button>)}
      </nav>
      <div className="min-w-0 space-y-6">
        {!enabled && <p className="rounded-xl border border-border bg-secondary p-4 text-sm">The assistant is being prepared. You can still <Link className="underline" href="/products">browse the shop</Link> and use your saved bags.</p>}
        <form onSubmit={submit} className="space-y-4 rounded-2xl border border-border bg-card p-5 md:p-7">
          <label htmlFor="assistant-message" className="block text-lg font-semibold">{modeInfo[mode].title}</label>
          <textarea id="assistant-message" value={message} onChange={e => setMessage(e.target.value)} disabled={busy} maxLength={4000} required rows={5}
            className="w-full rounded-xl border border-border bg-background p-4 text-base focus:outline-brand-green" />
          {mode === 'shopping' && <div><label htmlFor="assistant-budget" className="mb-2 block text-sm font-medium">Maximum total, including delivery (Rs.)</label>
            <input id="assistant-budget" type="number" min="1" max="1000000" step="0.01" required disabled={busy} value={budget} onChange={e => setBudget(e.target.value)} className="h-12 w-full rounded-lg border border-border bg-background px-4 sm:w-60" /></div>}
          {mode === 'producer' && <div><label htmlFor="assistant-photo" className="block text-sm font-medium">Optional product photo · maximum 2 MB</label>
            <input id="assistant-photo" type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={e => void uploadPhoto(e.target.files?.[0])} className="mt-2 max-w-full text-sm" />
            {photoName && <p className="mt-2 text-xs">Attached: {photoName} <button type="button" onClick={() => { setPhoto(undefined); setPhotoName(''); }} className="underline">Remove</button></p>}</div>}
          <p className="text-xs text-muted-foreground">AI can make mistakes. Your request{mode === 'producer' ? ' and attached photo' : ''} and relevant tool results are processed by our AI provider. Include all relevant details each time; this workspace does not remember earlier messages.</p>
          <button type="submit" disabled={busy || !enabled} className="editorial-button disabled:cursor-not-allowed disabled:opacity-50">
            {busy ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />Checking the details…</> : <>Prepare my suggestion <ArrowUpRight className="ml-2 h-4 w-4" /></>}
          </button>
        </form>
        {error && <p role="alert" className="rounded-xl border border-destructive/30 p-4 text-sm text-destructive">{error}</p>}
        {reply && <section aria-label="Assistant response" aria-live="polite" className="whitespace-pre-wrap rounded-2xl bg-secondary p-6 text-sm leading-7">{reply}</section>}
        <section aria-label="Recent proposals" className="space-y-5">
          {drafts.map(draft => <DraftCard key={draft.id} draft={draft} confirming={confirming} onConfirm={() => void confirm(draft)} />)}
        </section>
      </div>
    </div>}
  </main>;
}

function DraftCard({ draft, confirming, onConfirm }: { draft: DraftView; confirming?: string; onConfirm: () => void }) {
  const basket = draft.kind === 'basket' ? draft.payload as BasketQuote : null;
  const support = draft.kind === 'support' ? draft.payload as { message: string; orderId: string } : null;
  const proposal = !basket && !support ? draft.payload as Proposal : null;
  const confirmed = draft.status === 'confirmed';
  const link = reviewLinks[draft.kind];
  return <article className="rounded-2xl border border-border bg-card p-5 md:p-7">
    <p className="text-[11px] uppercase tracking-widest text-muted-foreground">{confirmed ? 'Confirmed' : 'For your review'} · {draft.kind}</p>
    <h2 className="mt-2 text-xl font-semibold text-brand-green">{draft.title}</h2>
    {basket && <>
      <ul className="my-5 divide-y divide-border">{basket.lines.map(line => <li key={line.productId} className="flex justify-between gap-3 py-3 text-sm">
        <div><p className="font-medium">{line.name}</p><p className="mt-1 text-xs text-muted-foreground">{line.quantity} × {line.pack} · {money(line.price)} each</p></div><span className="shrink-0">{money(line.total)}</span>
      </li>)}</ul>
      <dl className="space-y-2 border-t border-border pt-4 text-sm"><div className="flex justify-between"><dt>Products</dt><dd>{money(basket.subtotal)}</dd></div>
        <div className="flex justify-between"><dt>Estimated delivery</dt><dd>{money(basket.shipping)}</dd></div><div className="flex justify-between text-lg font-semibold"><dt>Estimated total</dt><dd>{money(basket.total)}</dd></div></dl>
      <p className="mt-3 text-xs text-muted-foreground">Budget: {money(basket.budget)}. Delivery area is checked at checkout. Saving a bag does not reserve stock or place an order.</p>
    </>}
    {support && <p className="my-4 whitespace-pre-wrap text-sm leading-6">{support.message}</p>}
    {proposal && <div className="my-4 space-y-4 text-sm leading-6"><p className="whitespace-pre-wrap">{proposal.summary}</p>
      <ul className="list-disc space-y-2 pl-5">{proposal.recommendations.map((item, i) => <li key={i}>{item}</li>)}</ul>
      {!!proposal.missingInformation.length && <div className="rounded-xl bg-secondary p-4"><h3 className="font-semibold">Still to verify</h3><ul className="mt-2 list-disc pl-5">{proposal.missingInformation.map((item, i) => <li key={i}>{item}</li>)}</ul></div>}
      <p className="text-muted-foreground">Review-only proposal. No listing, stock, supplier request or campaign has been changed or sent.</p>
      {link && <Link href={link.href} className="inline-flex min-h-11 items-center text-brand-green underline">{link.label}</Link>}
    </div>}
    {(basket || support) && <div className="mt-5">
      {confirmed ? <p className="flex flex-wrap items-center gap-2 text-sm text-brand-green"><Check size={18} />{basket ? 'Saved to your bags.' : 'Support request submitted.'}{basket && <Link href="/bags" className="underline">Review bags and checkout</Link>}</p> : <>
        <p className="mb-3 text-xs text-muted-foreground">Confirm by {new Date(draft.expiresAt).toLocaleTimeString('en-LK', { hour: '2-digit', minute: '2-digit' })}. Expired or changed quotes require a new draft.</p>
        <button type="button" disabled={!!confirming} onClick={onConfirm} className="editorial-button disabled:opacity-50">{confirming === draft.id ? 'Confirming…' : basket ? 'Confirm and save bag' : 'Confirm and submit support request'}</button>
      </>}
    </div>}
  </article>;
}
