# Credential exchange experience

All user-facing copy is English-only. Security and consent actions use plain
language; standards terminology appears in expandable protocol evidence.

The mobile product name is **Identity Wallet** with a persistent **DEMO**
badge. The web application is **Credential Exchange Demo**, containing
**DUMMY-CORP Demo Issuer** and **Partner Access Portal** roles.

## Visual direction

The experience is calm and institutional rather than crypto-themed. Mobile
uses deep ink, warm ivory surfaces, restrained teal trust accents, tactile
credential cards, and a visually dominant Scan action. Web uses an editorial
light canvas with warm amber for the issuer and blue or teal for the RP.
Fraunces remains the display face and IBM Plex Mono is reserved for technical
evidence.

Layouts support readable text scaling, reduced motion, WCAG-conscious
contrast, and at least 44-point touch targets. Gradients, glassmorphism,
blockchain imagery, and decorative QR treatments are excluded.

## DID Wallet

First launch explains the DEMO scope, synthetic data, online requirement, and
device-unlock protection; accepts the current Operator Token; and offers one
**Create wallet** action. That action generates the controller key, publishes
and publicly resolves the holder DID, and enters Wallet only after validation.
Later launches restore directly to Wallet and request a new Operator Token only
when a privileged action needs one.

The mobile app uses three primary destinations:

- **Wallet** presents the holder DID, publication health, and credential cards
  with active, revoked, or expired status.
- **Scan** starts Credential Offer and Presentation Request QR exchanges.
- **Activity** contains local issuance, disclosure, denial, expiry, and
  revocation receipts.

Credential details show issuer, validity, status, held claims, and collapsed
technical evidence. Presentation Consent names the Relying Party and purpose,
contrasts shared and withheld claims, and requires an explicit approve or deny.
The existing seven-step controller flow moves under Developer Details.
Denial sends a claim-free `access_denied` response, consumes the request, and
creates holder and RP receipts without waiting for session expiry.

The Scan destination auto-detects issuance and presentation payloads. Camera
permission failure leads to instructions and a Developer Details action for
manually pasting an exchange URI; both paths use the same parser, trust checks,
and protocol implementation.

After a Credential Offer scan, the wallet verifies and previews the trusted
issuer DID, credential type, seven-day validity, holder-binding DID, and every
claim before requesting Credential Acceptance. Cancel sends no holder proof or
employee data and leaves the offer to expire.

## Companion Web

The landing page separates the two demo journeys: issue a credential or request
partner-portal access.

The issuer area shows the Demo Employee, issuer DID and trust evidence,
Credential Offer QR, issuance progress, issued credentials, and revocation.
It reveals a six-digit Transaction Code separately from the QR and labels that
placement as a demo substitute for production delivery over a second channel.
The issuer marks delivery complete only after the wallet's OpenID4VCI
`credential_accepted` notification confirms encrypted vault persistence;
storage failure produces `credential_failure`.
The Relying Party area shows its purpose and requested claims, a Presentation
Request QR, live completion state, and the final Access Decision.

The result distinguishes disclosed from withheld claims and reports independent
checks for issuer trust, signature, holder binding, audience and nonce,
expiration, and revocation. Protocol messages remain available as collapsed
evidence instead of dominating the experience.

Denied results use one primary category: request declined, credential expired,
credential revoked, employment not eligible, verification failed, or service
unavailable. The collapsed check list may identify the failed validation but
never exposes raw credentials, proofs, undisclosed claims, signing inputs, or
server errors.
