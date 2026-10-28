# Deploy on Vercel

The storefront, assistant, public MCP tools and A2A quotation pilot can share one Next.js deployment. PostgreSQL persists commerce data, conversations, partner tasks and shared quotas. AI Gateway routes model requests; the model provider performs inference.

## Deploy in stages

1. Import `FreshOnTime/Agentic-FreshPick` as a Next.js project using the repository root, `npm ci` and `npm run build`. Select current Node 22 (22.12+) or Node 24.
2. Use a separate staging database. Configure `DATABASE_URL`, strong `JWT_SECRET`, `NEXT_PUBLIC_SITE_URL` and `FRONTEND_URL` for that deployment.
3. Set approved delivery fees, minimum, optional free-delivery threshold and supported cities. An unset `DELIVERY_FEE_LKR` blocks quotations and checkout.
4. Apply `npm run db:migrate` before runtime traffic, including `20261029010000_partner_quotations`. Use a controlled migration step, not concurrent migrations in every preview build.
5. Configure integrations from the [developer guide](DEVELOPER_GUIDE.md). Runtime uploads require durable Supabase Storage; serverless local files do not persist.
6. Keep `AGENTIC_ENABLED=false` and `A2A_ENABLED=false` until their prerequisites are configured. Enable and test each separately.

## Assistant

Set server-only `AI_GATEWAY_API_KEY`, an available tool-calling `AGENT_MODEL` and `AGENTIC_ENABLED=true`. Photo drafts also need model image input. The Node.js route declares 60 seconds maximum duration and a 50-second generation deadline; check deployed duration settings and plan support.

Verify authenticated conversations, follow-ups, revisions, bag confirmation and owned-order support. Provider behavior and cost require live model tests, not only mocks.

## MCP

`/api/mcp` recognizes `NEXT_PUBLIC_SITE_URL` and current `VERCEL_URL` / `VERCEL_PROJECT_PRODUCTION_URL` when `VERCEL=1`. Add exact extra origins to `MCP_ALLOWED_ORIGINS`; do not allow all Vercel preview domains.

Apply the shared-rate migration first. Missing/unavailable rate storage fails closed with 503. Verify access through a real MCP client; Vercel Deployment Protection can block requests before they reach the app.

## A2A

Follow [partner setup](A2A.md). Configure the canonical HTTPS `A2A_PUBLIC_URL`, separate credentials and `A2A_ENABLED`. Verify discovery and an SDK-client quotation on the deployed host.

The pilot is synchronous and uses no model tokens. Future tasks waiting for suppliers or approvals need durable workflow/queue execution with persisted progress. Returning an HTTP response does not keep arbitrary background work alive.

## Scheduled jobs

The inherited `netlify/functions/` schedules are **not automatically scheduled by Vercel**. Recurring orders, subscription deliveries and email outbox processing need protected Vercel Cron/Workflow adapters or a separate worker before those features can operate on Vercel.

Avoid duplicate schedulers. Reuse domain services and verify timing, retries and ownership when adapting them. This update does not activate or migrate those schedules.

## Operations

Monitor latency, quota rejections, database connections, model spend and failed runs. Keep functions and database geographically close. The Prisma helper adjusts supported Supabase pooler URLs and limits runtime connections; migrations use the original database URL.

Remove expired rate buckets with a controlled maintenance job:

```sql
DELETE FROM api_rate_buckets WHERE "resetAt" < NOW() - INTERVAL '1 day';
```

Cleanup is not scheduled by this update. Define task/history retention before onboarding. See [Operations](OPERATIONS.md) and [Platform readiness](PLATFORM_READINESS.md) for backups and fulfilment acceptance.
