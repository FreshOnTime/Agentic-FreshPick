import { createHash } from 'node:crypto';
import prisma from '@/lib/prisma';

export class SharedRateLimitError extends Error {
  constructor(public retryAfter: number) { super('Too many requests. Please retry later.'); }
}

/** A fixed window shared by every worker, with bounded keys and no stored raw IPs. */
export async function consumeSharedRateLimit(namespace: string, identity: string, limit: number, seconds = 60) {
  const id = `${namespace}:${createHash('sha256').update(identity).digest('hex')}`;
  const retryAfter = await prisma.$transaction(async tx => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`rate:${id}`}))`;
    const now = new Date();
    const previous = await tx.apiRateBucket.findUnique({ where: { id } });
    if (!previous || previous.resetAt <= now) {
      await tx.apiRateBucket.upsert({ where: { id }, create: { id, count: 1, resetAt: new Date(now.getTime() + seconds * 1000) },
        update: { count: 1, resetAt: new Date(now.getTime() + seconds * 1000) } });
      return 0;
    }
    if (previous.count >= limit) return Math.max(1, Math.ceil((previous.resetAt.getTime() - now.getTime()) / 1000));
    await tx.apiRateBucket.update({ where: { id }, data: { count: { increment: 1 } } });
    return 0;
  });
  if (retryAfter) throw new SharedRateLimitError(retryAfter);
}

export function publicClientIdentity(request: Request) {
  // Trust only the active host's documented ingress header. Other hosts share a
  // conservative fallback quota instead of letting arbitrary headers bypass it.
  if (process.env.VERCEL === '1') return request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  if (process.env.NETLIFY === 'true') return request.headers.get('x-nf-client-connection-ip') || 'unknown';
  return 'unknown';
}
