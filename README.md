# LoanDesk

A mortgage-lead qualifying desk. An inbound lead comes in, an AI rep qualifies them, a meeting is booked, a CRM payload is posted, and a staff UI shows every mapping failure instead of swallowing it.

This is a portfolio project, not a live system. It shows signed webhook ingestion that is safe to retry, outbound CRM posts that retry on a backoff, money stored as integer cents, AI output treated as untrusted input, and failures that return 4xx instead of a silent 200. The mapping code you want is `src/domain/money.ts`, `src/domain/qualify.ts` (`toCrmContact`), and `src/webhooks/webhooks.service.ts`.

The API is NestJS. Modules are `webhooks`, `leads`, `qualifier`, and `crm`.

## Why cents

`$450,000` parsed as a float, or split on a comma, becomes $450 or $45. That is a real loss-of-trust bug on a lending desk. `parseMoneyToCents` never uses float. It treats the amount as a string, accepts US grouping and a `k`/`m` suffix, and returns integer cents. `$450,000` is `45000000`. `450.000` is rejected as `MONEY_AMBIGUOUS` because US and EU locales disagree. JSON numbers with a fraction are rejected for the same reason.

Loan amount is stored as SQLite `INTEGER`. The CRM payload uses `loanAmountCents`, not a money string the next system has to guess at.

## Why the model cannot POST to CRM

The qualifier prompt collects name, phone, amount, purpose, timeline, credit band, and meeting. The model output is typed as `unknown`. `sanitizeExtraction` keeps the keys we own and drops the rest (`approved`, invented pipeline names, anything else). `qualifyLead` parses money and phone. `toCrmContact` is the only function that writes CRM field names:

- `name`
- `phone` (E.164)
- `loanAmountCents`
- `purpose`
- `timeline`
- `creditBand`
- `meeting` (`{ booked, startsAt }`)

n8n, Pipedrive, Bonzo, or a homegrown CRM maps those names on their side. LoanDesk does not clone a vendor schema.

## Why idempotency

Lead sources retry. A 500 followed by a replay must not create a second contact or post CRM twice with a mutated amount. `Idempotency-Key` (or `externalId`) plus a payload hash: same key and body returns the same lead. Same key and a different body is `409 IDEMPOTENCY_CONFLICT`. A mapping failure is stored as a red row and replayed as 4xx, never 200.

## Why signatures

Anyone who finds the URL can POST a lead. With `WEBHOOK_SECRET` set, `POST /webhooks/lead` and `POST /webhooks/voice` need two headers:

- `X-LoanDesk-Timestamp`: Unix seconds.
- `X-LoanDesk-Signature`: `sha256=` + hex HMAC-SHA256 of `{timestamp}.{raw body}` with the secret.

The HMAC is over the bytes received, not re-serialized JSON. A missing, wrong, or older-than-5-minutes signature is `401` and nothing is stored. The check runs before idempotency, so a forged request cannot claim a key. `npm start` refuses to boot in production without the secret. Leave it empty locally and the curl demo below works unsigned.

```bash
TS=$(date +%s); BODY=$(cat fixtures/inbound-lead.json)
SIG="sha256=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$WEBHOOK_SECRET" -hex | awk '{print $NF}')"
curl -sS -X POST http://127.0.0.1:8787/webhooks/lead -H 'content-type: application/json' \
  -H 'Idempotency-Key: lead_450k_demo' -H "X-LoanDesk-Timestamp: $TS" -H "X-LoanDesk-Signature: $SIG" \
  --data-binary "$BODY"
```

## Why outbound retries

The CRM goes down too. A `5xx`, `408`, `429`, or network error marks the lead `failed`, and a sweep re-posts it after 30s, 1m, 2m, then 4m (5 attempts in total). Every attempt sends the same `Idempotency-Key: loandesk-crm-<lead id>`, so if the CRM got an earlier POST and only the response was lost, it can drop the repeat. Any other `4xx` is `rejected`: the CRM refused this body and will refuse it again, so it waits for a person. Both stay visible in the staff UI, which shows when the next attempt is due, marks a lead **gave up** once its attempts run out, and keeps its **Retry CRM post** button.

With `CRM_SIGNING_SECRET` set, each CRM POST is signed the same way as inbound: `X-LoanDesk-Timestamp` and `X-LoanDesk-Signature` over `{timestamp}.{body}`. The receiver (an n8n Code node, for example) recomputes the HMAC and drops anything that doesn't match. Every attempt is signed when it is sent, so a retry minutes later still falls inside the receiver's 5-minute window. Use a different secret from `WEBHOOK_SECRET`: one is shared with lead sources, the other with the CRM side.

## Delivery log

A lead keeps every CRM attempt, not just the last response. Each row in `crm_deliveries` records the attempt number, what triggered it (`initial`, `auto_retry`, or `manual` for the staff button), when it started, how long it took, the status code (null when nothing came back), the outcome, the network error if there was one, and the first 4000 characters of the response. The lead page shows them as a timeline, so during an outage you can see when posts started failing, what the CRM said, and which retry got through. `GET /api/leads/:id` returns the same rows as `crmDeliveries`.

Local outbox writes (no `CRM_WEBHOOK_URL`) are not HTTP deliveries and are not logged here.

## Webhook contract

`POST /webhooks/lead` accepts a messy JSON object. Nested `customFields`, money as a string, extra keys ignored. Identity is `externalId` or `id`. Phone must parse to US/Canada E.164. Bad mapping is 4xx with `{ error: { code, message, field } }`. Success is 200. Failure is never 200.

`POST /webhooks/voice` accepts a Vapi/Retell-shaped envelope so a live provider can be wired later without rewriting mapping. Structured data from the model still goes through `sanitizeExtraction`. Simulated call does not need `VAPI_API_KEY`.

## What is real vs simulated

| Piece | State |
| --- | --- |
| Money parse, mapping, idempotency, 4xx | Real. Covered by `npm test`. |
| Inbound signature check, outbound CRM retry | Real. Covered by `npm test`. |
| Staff UI, SQLite, CRM outbox file | Real locally. |
| `CRM_WEBHOOK_URL` | Real POST if you set it. Otherwise SQLite + `data/crm-outbox.jsonl`. |
| Qualifier LLM | OpenAI if `OPENAI_API_KEY` is set. Fixture replies otherwise. Tests always use fixtures. |
| Voice | Browser simulate-call streams SSE. Live Twilio / A2P / Vapi is not in this repo. |
| Pipedrive / Bonzo | Not live. Point `CRM_WEBHOOK_URL` at n8n (or any HTTP endpoint) and map LoanDesk's schema there. |

This app is not deployed. There is no live URL.

## 5-minute demo

```bash
cp .env.example .env
npm install
npm test
npm run dev
```

API is `http://127.0.0.1:8787`. UI is `http://127.0.0.1:5173`.

1. Post a messy lead:

```bash
curl -sS -X POST http://127.0.0.1:8787/webhooks/lead \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: lead_450k_demo' \
  --data-binary @fixtures/inbound-lead.json
```

You should see `loanAmountCents: 45000000`. Open the UI. The lead is there. CRM request JSON uses cents.

2. Post a bad amount:

```bash
curl -sS -i -X POST http://127.0.0.1:8787/webhooks/lead \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: lead_bad_money' \
  --data-binary @fixtures/inbound-bad-money.json
```

HTTP 400, `MONEY_AMBIGUOUS`. The staff table shows a red row with that code and the raw payload. Replay the same curl. Still 400, still one row.

3. In the UI, Run a call. Type something like: `Alex Rivera. 415-555-0100. Looking at $450,000 to purchase in 45 days. Credit is good.` End call and map. Dropped fields such as `approved` show on the lead. The CRM body still has our seven keys.

## How to run

```bash
npm install
npm test          # jest
npm run dev       # NestJS API + Vite UI
npm run build && npm start   # production: Nest serves API, static UI from dist/web if you copy it
```

## Deploy

Not live. Two paths:

**Docker**

```bash
docker build -t loandesk .
docker run --rm -p 8787:8787 --env-file .env loandesk
```

Set `WEBHOOK_SECRET` (the container will not start without it) and `CRM_WEBHOOK_URL` in the environment. Secrets stay in env. Do not bake keys into the image.

**Cloudflare Workers** is a later move (D1 instead of better-sqlite3). This repo ships a Node + NestJS server because SSE, SQLite, and `npm test` run without a Cloudflare account.

## Known gaps

- No Twilio and no A2P 10DLC. The voice webhook envelope is ready; the carrier is not.
- No live Pipedrive or Bonzo connector. Outbound is one HTTP POST of our schema.
- No live voice provider. Simulate-call is the demo. Plug Vapi/Retell into `POST /webhooks/voice` when you have a key.
- Meeting "booked" is a field on the payload, not a Calendar API.
- `POST /webhooks/voice` uses LoanDesk's signature scheme, so a relay such as n8n can sign and forward calls. Vapi and Retell each sign with their own scheme, so calling it from one of them directly needs that provider's check added.
- The CRM retry sweep is a timer in the API process. Run one instance, or move it to a queue before scaling out.
- A lead that used up its retries shows **gave up** in the UI. Nothing pages anyone yet.

That is honest. The qualifying work is the mapping boundary, the cents type, and refusing to 200 on a bad `$450,000`.
