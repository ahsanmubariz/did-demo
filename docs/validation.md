# Validation record

The automated record was refreshed on 2026-07-31 from the Linux workstation.
The physical-iPhone section remains an operator acceptance test because the
workstation cannot operate Expo Go.

## Automated gates

Run:

```bash
npm run check
npx expo-doctor@latest
npm run web:build
npm run export:ios
```

The suite exercises:

- independent ES256 and SD-JWT disclosure vectors;
- credential metadata integrity and exact DCQL matching;
- real HTTP and temporary SQLite Companion persistence;
- OpenID4VCI offer, transaction code, nonce, holder proof, encrypted
  persistence-before-acknowledgement, and idempotency;
- RP-DID-signed OpenID4VP requests, consent, denial, browser binding, and short
  partner access;
- signed compressed status lists, revocation denial, supersession, rotation
  guard, reset, startup cleanup, and rate limiting;
- React Native product behavior and React/Vite issuer behavior;
- TypeScript across mobile, Companion, publisher compatibility, and web.

Latest result:

- `npm run check`: 14 suites and 43 tests passed; TypeScript and lint passed
  with no warnings.
- `npx expo-doctor@latest`: 18 of 18 checks passed.
- `npm run web:build`: production bundle completed, including locally bundled
  Fraunces and IBM Plex Mono assets.
- `npm run export:ios`: Hermes iOS export completed from 663 modules with four
  bundled font assets.

## Local production smoke

After `npm run web:build`, start `npm run companion` and confirm:

```bash
curl --fail-with-body http://127.0.0.1:8787/healthz
curl --fail-with-body http://127.0.0.1:8787/issuer/did.json
curl --fail-with-body http://127.0.0.1:8787/rp/did.json
curl --fail-with-body http://127.0.0.1:8787/status/employee
curl --fail-with-body http://127.0.0.1:8787/
```

The smoke uses the real built web assets, Node SQLite file, and persistent role
keys.

Latest result: passed against a fresh temporary SQLite directory on port 8799.
Health, issuer DID, RP DID, issuer metadata, signed status-list JWT, protected
operator summary, and the built SPA were all checked. Temporary state was
removed afterward.

## Fixed-ngrok smoke

With the fixed route forwarding to `127.0.0.1:8787`, check:

```bash
curl --fail-with-body \
  https://wallet.example.test/healthz

curl --fail-with-body \
  https://wallet.example.test/issuer/did.json

curl --fail-with-body \
  https://wallet.example.test/rp/did.json
```

The holder DID endpoint returns `404` until the iPhone onboarding flow publishes
its document; that is the expected clean-state result.

Latest result: passed. The previous Publisher listener on port 8787 was replaced
with Companion Web; the fixed ngrok origin returned the new health shape,
issuer DID, RP DID, issuer metadata, and built Credential Exchange Demo page.

## Physical iPhone acceptance

Use the checklist in the README. In particular, verify LAN Metro loading,
camera scanning, encrypted persistence across an Expo Go restart, exact consent
copy, browser binding, denial, revocation, and coordinated reset.
