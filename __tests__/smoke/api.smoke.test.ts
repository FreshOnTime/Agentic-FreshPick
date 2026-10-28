/**
 * Smoke tests to verify critical API endpoints are working in production
 */

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

describe('Smoke Tests - Critical API Endpoints', () => {
  const timeout = 10000; // 10 seconds

  describe('User API', () => {
    it('should handle user registration endpoint', async () => {
      const response = await fetch(`${BASE_URL}/api/users/register`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        // Intentionally invalid input: smoke checks must never create accounts
        // when BASE_URL points at a deployed site.
        body: JSON.stringify({}),
      });
      expect(response.status).toBe(400);
    }, timeout);
  });

  describe('Products API', () => {
    it('should retrieve products list', async () => {
      const response = await fetch(`${BASE_URL}/api/products?limit=5`);
      
      expect(response.status).toBe(200);
      
      const data = await response.json();
      expect(data).toHaveProperty('success');
      expect(data).toHaveProperty('data');
    }, timeout);

    it('should handle product search', async () => {
      const response = await fetch(`${BASE_URL}/api/products?search=test&limit=5`);
      
      expect(response.status).toBe(200);
      
      const data = await response.json();
      expect(data).toHaveProperty('success');
    }, timeout);
  });

  describe('Order authentication', () => {
    it('should reject anonymous order history', async () => {
      const response = await fetch(`${BASE_URL}/api/orders`);
      
      expect(response.status).toBe(401);
    }, timeout);
  });

  describe('Agentic workspace', () => {
    it('serves the assistant page without exposing private draft data', async () => {
      const response = await fetch(`${BASE_URL}/assistant`);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('FreshPick assistant');
    }, timeout);

    it('requires authentication for draft history', async () => {
      const response = await fetch(`${BASE_URL}/api/agentic`);
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }, timeout);

    it('protects conversation memory and proposal editing endpoints', async () => {
      const id = '00000000-0000-4000-8000-000000000001';
      expect((await fetch(`${BASE_URL}/api/agentic/conversations/${id}`)).status).toBe(401);
      expect((await fetch(`${BASE_URL}/api/agentic/drafts/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: new URL(BASE_URL).origin }, body: JSON.stringify({ action: 'dismiss' }) })).status).toBe(401);
    }, timeout);

    it('rejects anonymous generation and cross-origin requests before model execution', async () => {
      const request = { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: new URL(BASE_URL).origin }, body: JSON.stringify({ mode: 'shopping', message: 'Prepare a basket', budget: 1000 }) };
      expect((await fetch(`${BASE_URL}/api/agentic`, request)).status).toBe(401);
      expect((await fetch(`${BASE_URL}/api/agentic`, { ...request, headers: { ...request.headers, Origin: 'https://untrusted.example' } })).status).toBe(403);
    }, timeout);
  });

  describe('Partner protocol boundaries', () => {
    it('never serves partner tasks to an anonymous client', async () => {
      const response = await fetch(`${BASE_URL}/api/a2a`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'smoke', method: 'ListTasks', params: {} }) });
      // Disabled/unconfigured deployments return 503; enabled deployments require credentials.
      expect([401, 503]).toContain(response.status);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect((await fetch(`${BASE_URL}/api/a2a`)).status).toBe(405);
    }, timeout);

    it('serves either a disabled discovery response or a valid public Agent Card', async () => {
      const response = await fetch(`${BASE_URL}/.well-known/agent-card.json`);
      expect([200, 503]).toContain(response.status);
      const body = await response.json();
      if (response.status === 200) {
        expect(body.supportedInterfaces[0].protocolVersion).toBe('1.0');
        expect(body.skills[0].id).toBe('prepare_quote');
      } else expect(body.error).toBeTruthy();
    }, timeout);
  });

  describe('Categories API', () => {
    it('should retrieve categories list', async () => {
      const response = await fetch(`${BASE_URL}/api/categories`);
      
      expect([200, 404]).toContain(response.status);
    }, timeout);
  });

  describe('Brands API', () => {
    it('should retrieve brands list', async () => {
      const response = await fetch(`${BASE_URL}/api/brands`);
      
      expect([200, 404]).toContain(response.status);
    }, timeout);
  });
});
