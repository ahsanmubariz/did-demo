# Repository architecture and TDD route

The demo stays in one repository so the mobile app, Companion Web, protocol
tests, and operator have one install and command surface. The workstation
service remains a separate runtime boundary, not a separate package.

## Modules

```text
App.tsx
src/
  wallet/
    capability.ts       public DID Controller Wallet behavior
    did-profile.ts      DID document construction and validation
    proof.ts            challenge, compact JWS, and verification
    credential.ts       SD-JWT credential processing
    presentation.ts     DCQL matching and selective presentation
    vault.ts            encrypted credential persistence
    types.ts
  adapters/
    expo-secrets.ts     expo-secure-store boundary
    expo-random.ts      expo-crypto boundary
    publisher-client.ts public HTTP client boundary
  ui/
    WalletScreen.tsx    wallet navigation and credential experience
    components/
companion/
  server.ts             one Express process and HTTP contract
  database.ts           durable SQLite state
  issuer/               OpenID4VCI, signing, and credential status
  relying-party/        OpenID4VP, verification, and access policy
  publisher/            DID publication routes
web/
  src/                  React issuer and Relying Party interface
```

Pure wallet code receives randomness, time, secret storage, and DID resolution
as injected public boundaries. It imports no Expo module. Expo adapters are
thin and are exercised on the physical-device smoke path.

The original fixed-document service needed no framework or database. The
credential-exchange extension supersedes that constraint: one Express process
serves the React/Vite application and all protocol routes, while built-in
SQLite persists issuer identity metadata, issued-credential status, and
claim-free Audit Events.

## Test tooling

- `jest-expo` runs all TypeScript tests on Linux.
- Pure wallet and Publisher HTTP tests exercise public APIs.
- Publisher test files select the Node Jest environment.
- React Native Testing Library drives visible UI behavior.
- Time, randomness, SecureStore, filesystem roots, and external HTTP are
  mocked only at those system boundaries.
- The fixed RFC/W3C-derived vectors are independent expected values.

## Vertical red-to-green slices

Each slice starts with one failing behavior test, adds only enough production
code to pass, and leaves refactoring until review.

1. **DID profile** — fixed key produces the independently known thumbprint and
   exact valid DID document; malformed/private documents are rejected.
2. **Proof** — fixed vector verifies; generated ES256 proof verifies; tamper,
   audience, nonce, expiry, and replay cases fail with stable categories.
3. **Publisher readiness/read** — black-box health and unpublished DID routes.
4. **Publisher publish** — pairing authorization, media/size/profile checks,
   atomic persistence, public resolution headers, rotation replacement.
5. **Publisher restart/reset** — document survives, token changes, reset is
   authorized and idempotent.
6. **Wallet lifecycle** — create/restore, publish, resolve, prove, and retain
   state across retryable failures through the public capability API.
7. **Safe rotation** — new key becomes local authority only after publish,
   resolve, and proof; failure rolls back to the old key.
8. **Guided UI** — pair and execute the next operation through user-visible
   controls; inspect evidence; distinguish retryable errors.
9. **Build contract** — typecheck, lint, Jest, Expo Doctor, and iOS Hermes
   export.
10. **Live smoke** — local Publisher, fixed ngrok route, public curl, optional
    Universal Resolver, and the physical Expo Go checklist.
11. **Credential format** — fixed SD-JWT vector, selective disclosure, holder
    binding, expiry, tamper, and issuer-trust failures.
12. **Issuance contract** — metadata, pre-authorized Credential Offer,
    proof-of-possession, one-time session use, vault persistence, notification,
    and receipt.
13. **Presentation contract** — DCQL request matching, Consent, direct response,
    nonce and audience validation, and withheld-claim evidence.
14. **Credential status** — signed Token Status List, wallet status refresh,
    revocation, and independent RP denial.
15. **Companion Web** — issuer and RP behavior through visible React controls.
16. **Protocol journey** — issue, disclose, grant, revoke, and deny through
    real HTTP with temporary SQLite.
17. **Physical QR smoke** — scan both exchanges in Expo Go and confirm the web
    and iPhone reach the same decisions.

## Completion gate

The implementation is complete when:

- all deterministic Linux tests pass;
- TypeScript and ESLint pass;
- Expo Doctor reports no incompatibility;
- Metro exports an iOS Hermes bundle;
- local black-box Companion Web and protocol smoke checks pass;
- the fixed ngrok URL returns a valid DID document while the operator runs the
  tunnel;
- the operator can issue, present, revoke, and observe denial through QR
  exchanges in Expo Go on the iPhone.

The last item cannot be automated from this Linux workstation and remains an
explicit operator acceptance step rather than being silently marked complete.
