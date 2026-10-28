'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Check } from 'lucide-react';
import type { BasketQuote, DraftView } from '@/lib/agentic/contracts';

const money = (value: number) => new Intl.NumberFormat('en-LK', { style: 'currency', currency: 'LKR' }).format(value);
type Proposal = { summary: string; recommendations: string[]; missingInformation: string[] };
const reviewLinks: Partial<Record<string, { href: string; label: string }>> = {
  producer: { href: '/dashboard', label: 'Producer portal' }, inventory: { href: '/admin/products', label: 'Product management' },
  procurement: { href: '/b2b', label: 'Business enquiries' }, growth: { href: '/admin/newsletter', label: 'Newsletter management' },
};

export default function DraftCard({ draft, confirming, onConfirm, onEdit }: { draft: DraftView; confirming?: string; onConfirm: () => void; onEdit: (action: 'dismiss' | 'revise', items?: { productId: string; quantity: number }[]) => void }) {
  const basket = draft.kind === 'basket' ? draft.payload as BasketQuote : null;
  const support = draft.kind === 'support' ? draft.payload as { message: string; orderId: string } : null;
  const proposal = !basket && !support ? draft.payload as Proposal : null;
  const confirmed = draft.status === 'confirmed';
  const [quantities, setQuantities] = useState<Record<string, number>>(() => Object.fromEntries((basket?.lines || []).map(line => [line.productId, line.quantity])));
  const dirty = basket?.lines.some(line => quantities[line.productId] !== line.quantity);
  const valid = Object.values(quantities).every(q => Number.isSafeInteger(q) && q >= 0 && q <= 1000) && Object.values(quantities).some(q => q > 0);
  const expired = new Date(draft.expiresAt).getTime() <= Date.now();
  const link = reviewLinks[draft.kind];
  return <article className="rounded-2xl border border-border bg-card p-5 md:p-7">
    <p className="text-[11px] uppercase tracking-widest text-muted-foreground">{confirmed ? 'Confirmed' : 'For your review'} · {draft.kind}</p>
    <h2 className="mt-2 text-xl font-semibold text-brand-green">{draft.title}</h2>
    {basket && <>
      <ul className="my-5 divide-y divide-border">{basket.lines.map(line => <li key={line.productId} className="flex justify-between gap-3 py-3 text-sm">
        <div><p className="font-medium">{line.name}</p><p className="mt-1 text-xs text-muted-foreground">{line.quantity} × {line.pack} · {money(line.price)} each</p>
          {!confirmed && <label className="mt-2 flex items-center gap-2 text-xs">Packs <input aria-label={`Packs of ${line.name}`} type="number" min="0" max="1000" step="1" value={quantities[line.productId]} disabled={!!confirming} onChange={e => setQuantities(current => ({ ...current, [line.productId]: Number(e.target.value) }))} className="h-10 w-20 rounded border border-border bg-background px-2" /><span className="text-muted-foreground">0 removes item</span></label>}
        </div><span className="shrink-0">{money(line.total)}</span>
      </li>)}</ul>
      <dl className="space-y-2 border-t border-border pt-4 text-sm"><div className="flex justify-between"><dt>Products</dt><dd>{money(basket.subtotal)}</dd></div>
        <div className="flex justify-between"><dt>Estimated delivery</dt><dd>{money(basket.shipping)}</dd></div><div className="flex justify-between text-lg font-semibold"><dt>Estimated total</dt><dd>{money(basket.total)}</dd></div></dl>
      <p className="mt-3 text-xs text-muted-foreground">Budget: {money(basket.budget)}. Delivery area is checked at checkout. Saving a bag does not reserve stock or place an order.</p>
      {!confirmed && <div className="mt-4 space-y-2"><p className="text-xs text-muted-foreground">{dirty ? 'Quantities changed. Recheck to see your new total before confirming.' : expired ? 'This quote expired. Recheck to review current prices.' : 'Adjust pack quantities, then recheck prices and availability.'}</p>
        <button type="button" disabled={!!confirming || !valid} onClick={() => onEdit('revise', Object.entries(quantities).filter(([, quantity]) => quantity > 0).map(([productId, quantity]) => ({ productId, quantity })))} className="min-h-11 rounded-lg border border-brand-green px-4 text-sm text-brand-green disabled:opacity-50">Recheck prices and quantities</button></div>}
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
        <button type="button" disabled={!!confirming || !!dirty || expired} onClick={onConfirm} className="editorial-button disabled:opacity-50">{confirming === draft.id ? 'Updating…' : basket ? 'Confirm and save bag' : 'Confirm and submit support request'}</button>
      </>}
    </div>}
    {!confirmed && <button type="button" disabled={!!confirming} onClick={() => onEdit('dismiss')} className="mt-3 min-h-11 px-2 text-sm text-muted-foreground underline disabled:opacity-50">Dismiss proposal</button>}
  </article>;
}
