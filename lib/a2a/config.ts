import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

const partnersSchema = z.array(z.object({
  id: z.string().regex(/^[a-z0-9_-]{1,64}$/),
  tokenSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict()).min(1).max(100);

export class PartnerAuthError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export function a2aOrigin() {
  const url = new URL(process.env.A2A_PUBLIC_URL || process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000');
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) {
    throw new PartnerAuthError('Configure an HTTPS A2A_PUBLIC_URL origin.', 503);
  }
  return url.origin;
}

export function requireA2aEnabled() {
  if (process.env.A2A_ENABLED !== 'true') throw new PartnerAuthError('Partner quotations are not enabled.', 503);
}

/** Partner identity comes only from a server-configured token, never message metadata. */
export function authenticatePartner(request: Request): string {
  requireA2aEnabled();
  let partners: z.infer<typeof partnersSchema>;
  try {
    partners = partnersSchema.parse(JSON.parse(process.env.A2A_PARTNERS || '[]'));
    if (new Set(partners.map(p => p.id)).size !== partners.length || new Set(partners.map(p => p.tokenSha256)).size !== partners.length) throw new Error();
  } catch { throw new PartnerAuthError('Partner authentication is not configured.', 503); }
  const match = /^Bearer ([A-Za-z0-9_-]{43,128})$/i.exec(request.headers.get('authorization') || '');
  if (!match) throw new PartnerAuthError('A partner bearer token is required.', 401);
  const digest = createHash('sha256').update(match[1]).digest();
  const partner = partners.find(p => timingSafeEqual(digest, Buffer.from(p.tokenSha256, 'hex')));
  if (!partner) throw new PartnerAuthError('Invalid partner credentials.', 401);
  return partner.id;
}
