# SafeCOI Outbound Agent API — Reference

This API allows **outbound AI agents** (voice/phone agents and email agents) to confirm Certificates of Insurance (COIs) with the issuing insurance agency or insurance company. Confirmation results automatically mark COIs as verified (`compliant`) in SafeCOI.

All endpoints under `/api/agent/v1` require either:
- `X-Agent-Key: sc_xxx` header, or
- `Authorization: Bearer sc_xxx`, or
- `Authorization: Bearer <admin JWT>` (admin sessions, for testing)

**Admin-only API key control**: keys can only be issued and revoked by an admin user via `POST/GET/DELETE /api/agent/v1/admin/keys` or from the **Outbound AI agent** section inside `/staff`. External agents cannot create their own keys.

---

## Base URL

Production: `https://safecoi.com/api/agent/v1`
Local/dev: `http://localhost:6030/api/agent/v1`

---

## 1. Authentication

### Create an agent API key (ADMIN ONLY)

```http
POST /api/agent/v1/admin/keys
Authorization: Bearer <admin JWT>
Content-Type: application/json

{ "name": "elevenlabs-voice-agent" }
```

Response (the plaintext `key` is returned **once — save it immediately**):

```json
{
  "ok": true,
  "key": {
    "id": "a1b2c3d4-...",
    "key": "sc_xxxxxxxxxxxxxxxxxxxxxxxx",
    "prefix": "sc_xxxxxxx",
    "name": "elevenlabs-voice-agent",
    "scopes": "coi:confirm",
    "created_at": "2026-11-19T08:00:00.000Z"
  }
}
```

### List keys (ADMIN ONLY)

```http
GET /api/agent/v1/admin/keys
Authorization: Bearer <admin JWT>
```

### Revoke a key (ADMIN ONLY)

```http
DELETE /api/agent/v1/admin/keys/:id
Authorization: Bearer <admin JWT>
```

---

## 2. Pull the confirmation queue

```http
GET /api/agent/v1/queue?channel=call&has_phone=true&limit=50
X-Agent-Key: sc_xxx
```

Query params (all optional):
- `channel`: `call` | `email` | `both` | `none`
- `has_phone`: `true` (producer phone present)
- `has_email`: `true` (producer email present)
- `status`: filter by last confirmation status (`in_progress`, `verified`, etc.)
- `limit`: 1–200 (default 50)

Response:

```json
{
  "count": 1,
  "items": [
    {
      "coi_id": "0f63b468-...",
      "sub_company_name": "Jason O'Connell, DBA: JD Overhead",
      "carrier": "Pekin Insurance",
      "expiration_date": "02/06/2023",
      "producer_phone": "312-555-0100",
      "producer_email": "agency@example.com",
      "preferred_channel": "both",
      "last_confirmation": null
    }
  ]
}
```

---

## 3. Get the confirmation dossier (call/email brief)

```http
GET /api/agent/v1/brief/:coiId
X-Agent-Key: sc_xxx
```

Response:

```json
{
  "coi": {
    "id": "0f63b468-...",
    "carrier": "Pekin Insurance",
    "policy_number": "POL-123456",
    "effective_date": "02/06/2022",
    "expiration_date": "02/06/2023",
    "status": "pending_review",
    "is_expired": true,
    "certificate_key": "cois/uuid.png"
  },
  "producer": {
    "name": "Metro Insurance Agency",
    "phone": "312-555-0100",
    "email": "certs@metroinsurance.test",
    "contact_person": "Karen"
  },
  "insured": {
    "name": "JD Overhead Doors LLC",
    "address": "123 Main St, Chicago IL 60601"
  },
  "insurers": [
    { "letter": "A", "name": "Pekin Insurance Company", "naic": "24228" }
  ],
  "policies": [
    {
      "type": "General Liability",
      "policyNumber": "GL-98765",
      "effectiveDate": "02/06/2026",
      "expirationDate": "02/06/2027",
      "is_expired": false,
      "limits": [
        { "label": "Each Occurrence", "amount": "$1,000,000" },
        { "label": "General Aggregate", "amount": "$2,000,000" }
      ]
    }
  ],
  "questions": [
    "Confirm each listed policy is ACTIVE and in force for insured \"JD Overhead Doors LLC\"",
    "Confirm expiration dates match: General Liability=02/06/2027",
    "Confirm the general liability includes Additional Insured coverage for the general contractor (CG 20 10 / CG 20 37 or equivalent) and Waiver of Subrogation",
    "Ask for the issuing insurer (not holding company), NAIC#, and the policy holder name/address as shown on the carrier's records"
  ],
  "preferred_channel": "both"
}
```

---

## 4. Outbound AI phone calls

### 4.1 Dispatch a call

```http
POST /api/agent/v1/calls/dispatch
X-Agent-Key: sc_xxx
Content-Type: application/json

{
  "coiId": "0f63b468-...",
  "toPhone": "312-555-0100",          // optional override
  "agentId": "voice-agent-1",         // optional provider agent id
  "provider": "external"              // twilio | elevenlabs | external
}
```

Response:

```json
{
  "confirmation": {
    "id": "c9a1b2...",
    "coi_id": "0f63b468-...",
    "channel": "call",
    "target": "agency",
    "recipient": "312-555-0100",
    "status": "in_progress",
    "created_at": "2026-11-19T08:00:00.000Z",
    "updated_at": "2026-11-19T08:00:00.000Z"
  },
  "dialing": {
    "to": "312-555-0100",
    "script_prompt": "You are the SafeCOI AI verification assistant calling on behalf of a general contractor. GOAL: confirm the following Certificate of Insurance...",
    "provider": "external"
  }
}
```

When `ELEVENLABS_API_KEY` + `ELEVENLABS_AGENT_ID` are configured on the server, `provider: "elevenlabs"` automatically triggers the call through ElevenLabs Conversational AI. When `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` are configured, `provider: "twilio"` places the call via Twilio. With `provider: "external"`, your external AI phone system places the call and reports results back.

### 4.2 Report call outcome

```http
POST /api/agent/v1/calls/:confirmationId/result
X-Agent-Key: sc_xxx
Content-Type: application/json

{
  "outcome": "verified",              // verified | rejected | unreachable | failed | voicemail
  "notes": "Spoke with agency rep Karen; confirmed GL-98765 active, expiration 02/06/2027",
  "answers": {
    "named_insured_active": true,
    "all_policies_active": true,
    "additional_insured_confirmed": true,
    "waiver_of_subrogation": true,
    "issuing_insurer": "Pekin Insurance Company",
    "naic": "24228"
  },
  "recordingUrl": "https://cdn.example.com/recordings/call-123.mp3"
}
```

`outcome: "verified"` automatically:
- sets the confirmation `status: "verified"`
- updates `cois.status = "compliant"`
- sets `cois.confirmed_via = "phone_call"`, `cois.confirmed_at`, `cois.confirmed_notes`
- removes the COI from the pending queue

### 4.3 Call webhook (Twilio / ElevenLabs completion callback)

```http
POST /api/agent/v1/webhooks/calls
Content-Type: application/json

{ "CallSid": "CA1234567890abcdef", "CallStatus": "completed", "Duration": 95 }
```

Attaches raw provider payload to the matching confirmation row.

---

## 5. Outbound confirmation emails

### 5.1 Send confirmation email to the agency

```http
POST /api/agent/v1/emails/send
X-Agent-Key: sc_xxx
Content-Type: application/json

{
  "coiId": "0f63b468-...",
  "toEmail": "certs@metroinsurance.test",   // optional override
  "personalMessage": "Please expedite — crew starts on Tuesday."
}
```

Builds a structured confirmation request (named insured, policies list, three reply questions) and sends it using SafeCOI's configured email transport (SMTP / Postmark / SendGrid / simulated). Creates a confirmation row with `channel: "email"`, `status: "in_progress"`.

### 5.2 Preview the email template

```http
GET /api/agent/v1/emails/template/:coiId
X-Agent-Key: sc_xxx
```

Response: `{ "subject": "...", "body": "..." }`

### 5.3 Report email reply outcome

```http
POST /api/agent/v1/emails/:confirmationId/result
X-Agent-Key: sc_xxx
Content-Type: application/json

{
  "outcome": "verified",              // verified | rejected | unreachable
  "notes": "Agency replied confirming all policies are active",
  "replyBody": "Yes, JD Overhead Doors LLC is an active account..."
}
```

`outcome: "verified"` automatically sets `cois.status = "compliant"` and `cois.confirmed_via = "email"`.

---

## 6. History & status

```http
GET /api/agent/v1/cois/:coiId/confirmations
X-Agent-Key: sc_xxx
```

```http
GET /api/agent/v1/confirmations/:id
X-Agent-Key: sc_xxx
```

```http
GET /api/agent/v1/admin/stats
Authorization: Bearer <admin JWT>
```

---

## 7. Recommended agent flow

```
External agent                      SafeCOI API
     │                                   │
     │  GET /queue                       │
     │──────────────────────────────────►│
     │  list of COIs needing             │
     │  ◄────────────────────────────────│
     │                                   │
     │  GET /brief/:coiId                │
     │──────────────────────────────────►│
     │  dossier (phone, policies, q's)   │
     │  ◄────────────────────────────────│
     │                                   │
     │  POST /calls/dispatch             │  (or /emails/send)
     │──────────────────────────────────►│
     │  dialing info + script            │
     │  ◄────────────────────────────────│
     │                                   │
     │  [AI agent places the phone call  │
     │   to the agency; speaks with rep; │
     │   transcribes + classifies answers]
     │                                   │
     │  POST /calls/:id/result           │
     │  { outcome: "verified", notes }   │
     │──────────────────────────────────►│
     │                                   │  cois.status → compliant
     │                                   │  confirmed_via → phone_call
     │  { ok: true }                     │
     │  ◄────────────────────────────────│
```

---

## 8. Provider configuration (optional)

Set on the server (e.g., in Railway):

- **ElevenLabs**: `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`
- **Twilio**: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`, `TWILIO_VOICE_URL` (optional custom TwiML)
- **Email transport**: SMTP (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`) / Postmark (`POSTMARK_SERVER_TOKEN`) / SendGrid (`SENDGRID_API_KEY`)

Without these, the API functions as an external-agent interface (`provider: "external"`).

---

## 9. Error responses

All errors return JSON `{ "error": "message" }` with appropriate status codes: `400` invalid input, `401` key/auth error, `403` non-admin, `404` not found, `500` server error.
