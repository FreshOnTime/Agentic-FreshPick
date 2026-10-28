# A2A partner quotations

FreshPick exposes an **A2A 1.0 quotation pilot**, using the official `@a2a-js/sdk` 1.3.0 JSON-RPC transport. Disabled by default, it prepares non-binding LKR quotations from exact product IDs, whole-pack quantities, delivery city and budget. It does not place orders, reserve stock, charge money or contact suppliers.

This deterministic commerce skill needs no model call or `AI_GATEWAY_API_KEY`. An external agent can discover products with MCP, then submit structured requirements here. Natural-language-only requests receive an input-required task explaining the fields needed; the pilot does not guess quantities or product matches from prose.

## Interfaces

| Interface | Audience | Capability |
| --- | --- | --- |
| `/api/mcp` | Public clients | Read products, prices and categories |
| `/api/agentic` | Signed-in customers/staff | Model-assisted conversations, tools and drafts |
| `/api/a2a` | Approved partner agents | Quotation tasks, follow-ups, retrieval and cancellation |

The existing checkout remains the purchasing flow. Partner tokens grant no authority over customer accounts. All interfaces can share the current modular application and database.

## Enable in staging

1. Use current Node 22 (22.12+) or Node 24 and run `npm ci`.
2. Apply `npm run db:migrate`, including `20261029010000_partner_quotations`.
3. Configure approved delivery fees/areas and a separate staging database.
4. Run `npm run a2a:partner -- cafe-example` locally. Securely deliver the generated bearer token to that partner. Append the printed `{id, tokenSha256}` entry to the server-only `A2A_PARTNERS` JSON array. Never run the generator in public CI or commit its output.
5. Set `A2A_PUBLIC_URL=https://YOUR-APP-HOST` (origin, no path) and `A2A_ENABLED=true`.
6. Verify discovery, a quote and cross-partner isolation on the deployed HTTPS host.

Partner IDs and token hashes must be distinct. Remove an entry to revoke access after redeployment. Replace its digest to rotate credentials while retaining ownership. Never reuse a partner ID for a different organization.

## Discovery

`GET /.well-known/agent-card.json` advertises JSON-RPC 1.0, `prepare_quote`, bearer authentication and no streaming, push notifications or extended cards. It returns 503 when disabled or misconfigured. Card URLs come from the configured application origin, never an untrusted Host header. GitHub Pages hosts docs, not the live Agent Card or API.

## Prepare a quotation

Find exact product IDs and pack sizes via MCP/catalog first. Quantity 2 below means two catalog packs, not necessarily two kilograms. Replace the illustrative UUID with a real product ID.

```bash
curl "$FRESHPICK_ORIGIN/api/a2a" \
  -H "Authorization: Bearer $FRESHPICK_PARTNER_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'A2A-Version: 1.0' \
  --data '{
    "jsonrpc":"2.0", "id":"quote-1", "method":"SendMessage",
    "params": {
      "message": {
        "messageId":"cafe-quote-2026-001", "role":"ROLE_USER",
        "parts":[{"mediaType":"application/json", "data":{
          "skill":"prepare_quote", "name":"Cafe produce", "budget":5000,
          "items":[{"productId":"11111111-1111-4111-8111-111111111111","quantity":2}],
          "delivery":{"city":"Colombo","country":"Sri Lanka"}
        }}]
      },
      "configuration":{"historyLength":0}
    }
  }'
```

The JSON-RPC result contains `{ "task": { ... } }`. Success has `status.state: "TASK_STATE_COMPLETED"` and an artifact containing discounted prices, line totals, subtotal, shipping, total, currency, delivery city, quotation time and expiry. It explicitly reports `requiresHumanApproval: true`, `orderPlaced: false` and `stockReserved: false`.

Completion means the quote was prepared. Quotes expire after 30 minutes. Identical retries return the original quote and expiry even after prices change. Use a new request to reprice, and revalidate all details in customer checkout before purchasing. Delivery dates and capacity are not promised.

## Follow-ups and task operations

Missing fields, unsupported cities, insufficient budgets and unavailable stock produce `TASK_STATE_INPUT_REQUIRED`. Send a new `SendMessage` with a new `messageId`, the returned `taskId` and the complete corrected data. Task snapshots retain the latest 20 history messages.

| Method | Parameters | Result |
| --- | --- | --- |
| `SendMessage` | `message`, optional `configuration` | Quote or input requirements |
| `GetTask` | `id`, optional `historyLength` | Owned task |
| `ListTasks` | Optional `contextId`, `status`, `pageSize`, `pageToken`, `historyLength`, `statusTimestampAfter`, `includeArtifacts` | Owned tasks; default 20, maximum 100 per page; artifacts excluded by default |
| `CancelTask` | `id` | Cancel a task awaiting input; completed quotes cannot be canceled |

Retrieval example: `{"jsonrpc":"2.0","id":"read-1","method":"GetTask","params":{"id":"TASK_UUID","historyLength":0}}`.

Use A2A **1.0** fields and uppercase enum strings. Always send `A2A-Version: 1.0`; the protocol's absent-header legacy default is unsupported. Older 0.3 clients need compatible 1.0 support. `returnImmediately`, streaming, webhooks, file parts and task references are not supported. Input URLs are never fetched.

## Identity, retries and limits

- Ownership comes from bearer credentials, never message metadata or caller-supplied tenant IDs. Other partners' task IDs produce the same not-found error as nonexistent tasks.
- `(partnerId, messageId)` is the retry key. Identical requests return a saved response; changed data/configuration with the same ID is rejected. Use new IDs for revisions.
- Task changes and receipts commit together under a database lock. Infrastructure errors roll back; retry the same message ID. No work is detached from the HTTP request.
- Shared PostgreSQL quotas enforce 60 protocol requests per partner per minute and 120 new messages per hour. Exact retries count toward the minute quota only.
- Input limits: 64 KiB; four text/data parts; one quote data part; 40 item lines; 1,000 combined packs per product; LKR 1,000,000 budget.
- Records contain partner requirements and quotation history. Define retention before production. Deleting a task cascades to its retry receipts and ends its retry guarantee; keep receipts while clients may retry.

## Verification and next steps

API tests cover authentication, discovery, negotiation and errors. `npm run test:a2a-db` uses an explicitly isolated PostgreSQL schema to test totals, concurrent retries, ownership, continuation, cancellation, pagination, shared quotas and absence of order/stock mutations. CI runs it alongside commerce tests.

This is not a live partner integration or full protocol conformance certification. Begin with one partner and reviewed quotations. Model-assisted interpretation, OAuth delegation and durable supplier coordination remain future work.

References: [A2A specification](https://a2a-protocol.org/latest/specification/), [official JavaScript SDK](https://github.com/a2aproject/a2a-js).
