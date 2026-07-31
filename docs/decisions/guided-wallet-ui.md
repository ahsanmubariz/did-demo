# Guided wallet UI

The production app uses a **cryptographic field notebook**: a single vertical
journey whose completed, active, blocked, and retryable operations remain
visible together.

## Why this structure won

Three runnable structures were compared on branch
`prototype/guided-wallet-ui`:

- **Field notebook** — chronological operation log with one active action.
- **Verification lab** — dense instrument panel centered on technical output.
- **Identity passport** — one operation per swipeable card.

Field notebook best serves a mixed technical audience because it preserves the
story from pairing through rotation without hiding previous evidence. The
Verification lab contributes its high-contrast evidence treatment. The
passport structure was rejected because moving one card at a time obscures the
relationship between local key state, public resolution, and proof state.

Prototype commit: `232843030271516e29a2b2f3050598a8fe7a6702`.

## Production composition

The screen is an industrial field record, not a generic finance wallet:

- warm paper canvas against an ink-black status header;
- Fraunces display typography for the identity title;
- IBM Plex Mono for DIDs, key IDs, JWS values, labels, and timestamps;
- safety-orange for the one current action;
- acid-green only for independently verified success;
- a thin vertical rail connecting the seven operations.

## Seven operations

1. **Pair** — enter the process-scoped Publisher token.
2. **Create** — generate or restore the P-256 controller key.
3. **Publish** — send the public DID document.
4. **Resolve** — fetch and validate the public document.
5. **Prove** — issue, sign, and verify a fresh challenge.
6. **Rotate** — safely replace the key while keeping the DID.
7. **Reset** — remove the public document and local demonstration state.

Only the next valid primary action is visually dominant. Completed operations
remain inspectable. Blocked operations explain their prerequisite instead of
showing a disabled control without context.

## Evidence panels

Expandable panels expose:

- Publisher origin and local/public health;
- full DID and verification-method ID;
- public DID document JSON;
- compact `did-auth+jwt`;
- decoded protected header and payload;
- verification outcome and stable failure category;
- old/new key thumbprints during rotation.

The default view summarizes these values in plain language. Raw evidence is
secondary and never replaces the narrative status.

## Failure presentation

Failures appear in the operation where they occurred and are classified as:

- pairing required;
- publisher unavailable;
- publication rejected;
- resolution transport/content/profile failure;
- proof invalid, expired, mismatched, or replayed;
- rotation rolled back.

Retryable failures retain the local identity. A `401` returns the UI to Pair
without implying that the key was lost.
