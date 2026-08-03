# I Built a Digital Identity Wallet Without a Blockchain

## Why I developed an end-to-end employee credential demo, and how it works with `did:web`, OpenID4VCI, SD-JWT, and OpenID4VP

I developed the Identity Wallet Demo to trace every step between issuing a digital credential and using it to enter a protected browser session.

The result is an iPhone wallet, a web-based issuer desk, and a partner access portal. Together they issue a synthetic Employee Credential, encrypt it on the phone, disclose only approved claims, verify the presentation, check revocation, and grant short-lived access.

The project uses HTTPS domains and public-key cryptography as its trust foundation. It has no blockchain node, cryptocurrency, smart contract, or local ledger.

The source code is available on GitHub: [github.com/ahsanmubariz/did-demo](https://github.com/ahsanmubariz/did-demo).

> This is demonstration software. It uses synthetic employee data, Expo Go software keys, a developer-controlled HTTPS domain, and one workstation process. It is not a production wallet, identity provider, or authorization system.

## What I developed

The mobile application is an identity wallet built with React Native and Expo Go. It creates and controls a `did:web` identity, receives a holder-bound credential, stores it in an encrypted local vault, and asks the holder before sharing any claims.

The companion web application has two working areas. The issuer desk creates and revokes an Employee Credential. The partner portal requests proof of active employment and opens a browser session after successful verification.

I used a fictional employee named Alya Pratama so the full experience could run without real personal data. Her credential contains a name, email address, employee ID, department, employer, and employment status.

The partner does not need all of that information. Its access policy asks for three facts:

- name;
- employer;
- employment status.

The wallet shows those requested claims before Alya approves the presentation. It also shows that her email, employee number, department, and full credential will stay on the phone.

The flow continues beyond a successful presentation. The issuer can revoke the credential, the wallet can refresh its status, and the partner checks that status before every access decision.

## Why I developed it

Generating a DID and signing a token proved too little for the problem I wanted to explore. A usable identity system also has to answer practical questions.

I needed the system to bind a credential to the holder’s key, protect it on the phone, show which claims would leave the device, attach each response to one request, and change the access decision after revocation. The holder also needed enough information to make a real decision before sharing.

Those questions cross protocol, storage, security, and interface boundaries. Testing one layer in isolation hides the handoffs between them.

I wanted the demo to make those handoffs visible. The QR code should not look like a container full of identity data. The issuer should not report success before the wallet saves the credential. The consent screen should name both the disclosed and withheld claims. A valid signature should not bypass expiry, nonce, audience, holder-binding, or status checks.

I also wanted to test the model without adding a blockchain. `did:web` keeps the trust chain close to infrastructure that web developers already operate: a domain, TLS, a DID document, and a public key. Trust still depends on domain control and key administration, and the demo makes that dependency explicit.

## How it works conceptually

The demo has three actors.

The holder owns the wallet and decides whether to share. The issuer creates the Employee Credential. The relying party requests the minimum proof required by its access policy.

Their interaction follows one continuous journey:

1. The wallet creates a holder key and publishes its DID document.
2. The issuer creates a short-lived credential offer.
3. The holder scans an HTTPS reference and enters a separate transaction code.
4. The wallet proves control of its key before receiving the credential.
5. The wallet encrypts and stores the credential on the iPhone.
6. The partner creates a request for specific claims.
7. The holder approves or denies the request in the wallet.
8. The partner verifies the presentation and current credential status.
9. The browser that started the request receives a ten-minute session.

The QR codes carry short-lived references. They contain neither the Employee Credential nor a presentation. The wallet follows each reference and completes the exchange over HTTPS.

Consent is part of the protocol journey rather than a decorative confirmation at the end. Approval creates a selective presentation. Denial sends `access_denied`, shares no credential claims, consumes the request, and creates a local receipt.

Browser binding keeps the result attached to its origin. A request created in one browser can unlock only that browser session. Scanning the same reference from an iPhone cannot grant access to another browser polling the endpoint.

## How the identity layer works

The public HTTPS origin determines the holder, issuer, and relying-party identifiers. With `https://wallet.example.com` as the configured origin, the demo derives these DIDs:

| Role | DID |
| --- | --- |
| Holder | `did:web:wallet.example.com` |
| Issuer | `did:web:wallet.example.com:issuer` |
| Relying party | `did:web:wallet.example.com:rp` |

The wallet creates a P-256 controller key and publishes the holder document at `/.well-known/did.json`. The issuer and relying party use separate persistent keys and separate DID documents.

After publication, the wallet resolves its DID document through the public route. It checks that the published key matches the local controller, then signs a fresh challenge to prove control.

Key rotation uses the same sequence. The wallet generates a candidate key, publishes it, resolves the result, and proves control. The new key becomes authoritative only after every step succeeds. A failure leaves the previous key in control.

## How credential issuance works

The issuer uses the OpenID4VCI pre-authorized code flow. An operator selects the synthetic employee and creates an offer. The issuer returns a short-lived reference and a single-use six-digit transaction code.

The web interface displays the QR reference and transaction code separately. This models a second delivery channel even though one operator can see both during the demo.

After the wallet scans the offer, it requests a credential nonce and signs a proof with the holder DID key. The issuer validates the nonce-bound proof before creating the credential. A copied offer cannot bind the credential to an unrelated key.

The issued object is an IETF SD-JWT Verifiable Digital Credential. It uses ES256 signatures, SHA-256 disclosure digests, and holder binding. The implementation does not claim W3C JSON-LD Verifiable Credential conformance.

Delivery finishes after storage. The wallet encrypts the credential and writes it to the local vault before sending the OpenID4VCI success notification. If persistence fails, the wallet sends a failure notification and the issuer leaves the exchange incomplete.

## How selective disclosure works

Each selectively disclosable claim has a salted disclosure. The signed SD-JWT contains digests of those disclosures. When the partner asks for name, employer, and employment status, the wallet sends only the disclosures needed for those claims.

The wallet also creates a key-binding JWT. It contains the audience, nonce, issue time, and hash of the presented SD-JWT. This proves that the presentation came from the holder key and belongs to the current request.

The relying party checks:

- the issuer identity and credential signature;
- holder-key binding;
- audience and nonce;
- issue and expiry times;
- the disclosed claim set;
- the partner’s access policy;
- current revocation status.

A credential signature proves who issued the credential. The remaining checks determine whether this presentation should grant access now.

## How storage and revocation work

The iPhone stores controller and vault keys through Expo SecureStore, backed by iOS Keychain. Before writing credential records to Expo SQLite, the wallet encrypts them with XChaCha20-Poly1305. SQLite stores the nonce and ciphertext. The encryption key remains in secure storage.

The vault locks when the application leaves the active state. Local activity receipts contain outcomes and claim names, with no credential values, proofs, or compact tokens.

The workstation uses a separate SQLite database for issuer metadata, credential status, exchanges, short-lived browser sessions, and claim-free audit events. Private role keys live in the configured state directory instead of the database.

Each issued credential receives an index in a signed, compressed Token Status List. The wallet can refresh the status, and the partner checks the list during verification. Once the issuer revokes the credential, later presentations fail even when their signatures remain valid.

## How I structured the implementation

The complete demo runs across two runtimes.

The iPhone application contains the wallet capabilities, protocol processing, encrypted vault, and React Native interface. Pure wallet modules receive randomness, time, secret storage, and HTTP behavior through injected boundaries. Expo-specific adapters stay at the edge.

The workstation runs one Express process. It serves the DID publisher, issuer and relying-party APIs, signed credential status, the built React web application, and SQLite-backed state.

The roles still have separate responsibilities. The issuer signs credentials. The relying party creates requests and verifies presentations. The publisher exposes DID documents. The wallet owns the holder key, encrypted credential, and consent decision.

I built the project in test-driven vertical slices. The automated suite covers DID document construction, known key thumbprints, ES256 proofs, tampering, replay, nonce and audience mismatch, safe key rotation, SD-JWT disclosure, over-disclosure, encrypted vault round trips, status lists, revocation, HTTP issuance, presentation, denial, browser binding, and both user interfaces.

At the time of writing, 50 tests pass across 15 suites. Physical-device validation still matters for camera permissions, iOS Keychain behavior, Metro connectivity, and the scan-and-consent experience.

## Limits and production gaps

Expo Go cannot provide an app-owned Secure Enclave key or an app-specific Face ID policy. Direct-post responses use TLS without additional JWE encryption. The publisher, issuer, relying party, and web application share one workstation process. Synthetic data replaces a real employee directory.

A production system would need stronger device-bound keys, credential recovery and migration rules, separate trust administration, hardened secret handling, monitoring, privacy review, and interoperability testing across independent vendors.

I kept those limits explicit because the project has a focused job: demonstrate one credential from issuance to encrypted storage, disclose three approved facts, verify them independently, and reject the credential after revocation.

The code, setup instructions, architecture notes, and validation steps are available at [github.com/ahsanmubariz/did-demo](https://github.com/ahsanmubariz/did-demo).
