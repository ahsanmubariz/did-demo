# DID Publisher contract

The DID Publisher is a single-user demonstration service. It exposes one fixed
`did:web` document, persists only public material, and treats a process-scoped
pairing token as the authority to replace or remove that document.

## Fixed identity

- DID: `did:web:wallet.example.test`
- Public origin: `https://wallet.example.test`
- Local origin: `http://127.0.0.1:8787`
- State file: `.data/did.json`

## Process lifecycle

1. Generate a 32-byte base64url pairing token at process startup.
2. Load and validate the persisted DID document when it exists.
3. Bind to `127.0.0.1:8787`; never bind the demo service to the LAN.
4. Print the public DID, state-file path, document presence, and pairing token.
5. Do not persist or log the token after startup.

Restarting invalidates the previous token without changing the published
document. The wallet treats a `401` as a prompt to pair again, not as identity
loss.

## Public HTTP interface

### `GET /healthz`

Returns `200` with:

```json
{"status":"ok","document":"present"}
```

or:

```json
{"status":"ok","document":"absent"}
```

### `GET /.well-known/did.json`

- Returns `404` JSON while no document has been published.
- Returns the exact persisted public document with `200` when present.
- Uses `application/did+ld+json; charset=utf-8`,
  `Access-Control-Allow-Origin: *`, `Cache-Control: no-store`, and
  `X-Content-Type-Options: nosniff`.

### `PUT /api/did`

Requires `Authorization: Bearer <pairing-token>` and JSON no larger than
64 KiB. It accepts only the fixed profile documented in
`research/did-web-proof-profile.md`, rejects private JWK material, and
atomically replaces the state file before returning `204`.

### `DELETE /api/did`

Requires the same authorization, removes the state file, and returns `204`
whether or not a document existed.

## Error contract

Errors are small JSON objects shaped as:

```json
{"error":"stable_machine_code","message":"Human-readable explanation"}
```

The stable cases are:

| Status | Code | Meaning |
| --- | --- | --- |
| `400` | `invalid_did_document` | JSON does not match the fixed DID profile |
| `401` | `pairing_required` | Pairing token is absent or invalid |
| `404` | `not_found` | Route or unpublished document does not exist |
| `405` | `method_not_allowed` | Known path used with an unsupported method |
| `413` | `payload_too_large` | Request exceeds 64 KiB |
| `415` | `unsupported_media_type` | Write request is not JSON |
| `500` | `persistence_error` | Atomic state operation failed |

Errors never echo authorization headers, tokens, request bodies, or private
key material.

## Wallet state transitions

```text
unpaired
  └─ pair(token) ───────────────▶ paired

paired + no local key
  └─ create identity ───────────▶ local identity

local identity
  └─ publish succeeds ──────────▶ published
  └─ 401 ───────────────────────▶ unpaired, identity retained
  └─ network/server failure ────▶ retryable, identity retained

published
  └─ resolve exact document ────▶ resolved
  └─ create/verify proof ───────▶ proven

proven
  └─ rotate + publish succeeds ─▶ new published key, same DID
  └─ rotate publish fails ──────▶ old key remains authoritative
```

Rotation keeps the old persisted private key until the new key has been
published, resolved, and used for a successful proof. Only then is the old key
deleted.

## Operational command

```bash
ngrok http 127.0.0.1:8787 \
  --url https://wallet.example.test \
  --inspect=false
```

The ngrok tunnel is transport, not wallet state. An offline tunnel is surfaced
as a retryable availability failure.
