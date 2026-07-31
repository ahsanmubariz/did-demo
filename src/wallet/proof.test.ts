import { base64urlnopad } from '@scure/base';
import { DID, buildDidDocument, type PublicP256Jwk } from './did-profile';
import {
  PROOF_AUDIENCE,
  ProofError,
  signProof,
  verifyProof,
  type Challenge,
} from './proof';

const fixtureJwk: PublicP256Jwk = {
  kty: 'EC',
  crv: 'P-256',
  x: 'f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU',
  y: 'x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0',
  alg: 'ES256',
  use: 'sig',
};

const fixtureSecret = base64urlnopad.decode(
  'jpsQnnGQmL-YBIffH1136cspYG6-0iY7X1fCE9-E9LI',
);
const document = buildDidDocument(fixtureJwk);
const keyId = document.authentication[0];
const positiveProof =
  'eyJhbGciOiJFUzI1NiIsImtpZCI6ImRpZDp3ZWI6d2FsbGV0LmV4YW1wbGUudGVzdCNvS0l5d3ZHVXBUVlR5eE1RM2J3SUllUVV1ZGZyX0NrTE1qQ0UxOUVDRC1VIiwidHlwIjoiZGlkLWF1dGgrand0In0.eyJpc3MiOiJkaWQ6d2ViOndhbGxldC5leGFtcGxlLnRlc3QiLCJhdWQiOiJ1cm46ZGlkLWRlbW86d2FsbGV0LXZlcmlmaWVyIiwiaWF0IjoxNzg1MzczMjAwLCJleHAiOjE3ODUzNzMzMjAsIm5vbmNlIjoiQUFFQ0F3UUZCZ2NJQ1FvTERBME9EdyJ9.e3enlOv0jtVyLZ5ar-Htq-tEMk-6vAsoYx1ZhkQrAaxd8YKR9XAEKTn8U_e84kFbwF9IZRzZEpWqO4BhQ5fcog';
const [positiveHeader, positivePayload, positiveSignature] = positiveProof.split('.') as [
  string,
  string,
  string,
];
const tamperedProof = `${positiveHeader}.${positivePayload}.${
  positiveSignature.startsWith('7') ? '8' : '7'
}${positiveSignature.slice(1)}`;

function challenge(overrides: Partial<Challenge> = {}): Challenge {
  return {
    expectedDid: DID,
    audience: PROOF_AUDIENCE,
    nonce: 'AAECAwQFBgcICQoLDA0ODw',
    issuedAt: 1785373200,
    expiresAt: 1785373320,
    consumed: false,
    ...overrides,
  };
}

function expectProofError(action: () => unknown, code: string) {
  try {
    action();
    throw new Error('Expected proof verification to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(ProofError);
    expect((error as ProofError).code).toBe(code);
  }
}

describe('DID control proof', () => {
  test('verifies the independent compact ES256 vector and consumes its challenge', () => {
    const state = challenge();
    expect(verifyProof(positiveProof, document, state, 1785373260)).toEqual({
      did: DID,
      keyId,
      issuedAt: 1785373200,
      expiresAt: 1785373320,
    });
    expect(state.consumed).toBe(true);
  });

  test('signs a proof that verifies through the public profile', () => {
    const state = challenge();
    const proof = signProof(
      fixtureSecret,
      keyId,
      state,
      new Uint8Array(32).fill(7),
    );
    expect(verifyProof(proof, document, state, 1785373260).did).toBe(DID);
  });

  test.each([
    ['invalid_signature', tamperedProof, challenge(), 1785373260],
    ['audience_mismatch', positiveProof, challenge({ audience: 'urn:other' }), 1785373260],
    ['expired_proof', positiveProof, challenge(), 1785373351],
    ['replayed_challenge', positiveProof, challenge({ consumed: true }), 1785373260],
  ])('reports %s as a stable failure category', (code, proof, state, now) => {
    expectProofError(
      () => verifyProof(proof as string, document, state as Challenge, now as number),
      code as string,
    );
  });
});
