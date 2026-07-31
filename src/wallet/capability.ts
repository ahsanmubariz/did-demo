import { p256 } from '@noble/curves/nist.js';
import { base64urlnopad } from '@scure/base';
import type { HttpPublisherClient } from '../adapters/publisher-client';
import {
  DID,
  buildDidDocument,
  publicJwkFromUncompressed,
  type DidDocument,
} from './did-profile';
import { createChallenge, signProof, verifyProof } from './proof';
import { createCredentialProof } from '../credentials/issuance';
import {
  createEmployeePresentation,
  RP_CLIENT_ID,
  type EmployeeClaimName,
  type IssuedEmployeeCredential,
} from '../credentials/sd-jwt';

const privateKeyName = 'did-demo.private-key';
const pendingPrivateKeyName = 'did-demo.pending-private-key';
const pairingTokenName = 'did-demo.pairing-token';

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface RandomSource {
  bytes(length: number): Promise<Uint8Array>;
}

export interface Clock {
  nowSeconds(): number;
}

export type WalletDependencies = {
  secrets: SecretStore;
  random: RandomSource;
  publisher: Pick<HttpPublisherClient, 'publish' | 'resolve' | 'reset'> &
    Partial<Pick<HttpPublisherClient, 'revokeActiveCredential'>>;
  clock: Clock;
};

export type WalletSnapshot = {
  did: typeof DID;
  paired: boolean;
  hasIdentity: boolean;
  published: boolean;
  resolved: boolean;
  proven: boolean;
  keyId?: string;
  didDocument?: DidDocument;
  resolvedDocument?: DidDocument;
  proof?: string;
};

export class WalletStateError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

export class DidControllerWallet {
  private pairingToken?: string;
  private secretKey?: Uint8Array;
  private didDocument?: DidDocument;
  private resolvedDocument?: DidDocument;
  private proof?: string;
  private isPublished = false;
  private isProven = false;

  constructor(private readonly dependencies: WalletDependencies) {}

  snapshot(): WalletSnapshot {
    const keyId = this.didDocument?.authentication[0];
    return {
      did: DID,
      paired: Boolean(this.pairingToken),
      hasIdentity: Boolean(this.secretKey && this.didDocument),
      published: this.isPublished,
      resolved: Boolean(this.resolvedDocument),
      proven: this.isProven,
      ...(keyId ? { keyId } : {}),
      ...(this.didDocument ? { didDocument: this.didDocument } : {}),
      ...(this.resolvedDocument ? { resolvedDocument: this.resolvedDocument } : {}),
      ...(this.proof ? { proof: this.proof } : {}),
    };
  }

  async restore(): Promise<WalletSnapshot> {
    const [encodedSecret, pairingToken] = await Promise.all([
      this.dependencies.secrets.get(privateKeyName),
      this.dependencies.secrets.get(pairingTokenName),
    ]);
    if (encodedSecret) {
      const secretKey = base64urlnopad.decode(encodedSecret);
      if (!p256.utils.isValidSecretKey(secretKey)) {
        throw new WalletStateError('invalid_local_key', 'Stored controller key is invalid');
      }
      this.setIdentity(secretKey);
    }
    if (pairingToken) this.pairingToken = pairingToken;
    return this.snapshot();
  }

  async pair(token: string): Promise<WalletSnapshot> {
    const normalized = token.trim();
    if (!normalized) {
      throw new WalletStateError('pairing_required', 'Enter the Publisher pairing token');
    }
    await this.dependencies.secrets.set(pairingTokenName, normalized);
    this.pairingToken = normalized;
    return this.snapshot();
  }

  async createIdentity(): Promise<WalletSnapshot> {
    const seed = await this.dependencies.random.bytes(p256.lengths.seed ?? 48);
    const { secretKey } = p256.keygen(seed);
    await this.dependencies.secrets.set(privateKeyName, base64urlnopad.encode(secretKey));
    this.setIdentity(secretKey);
    return this.snapshot();
  }

  async publish(): Promise<WalletSnapshot> {
    const token = this.requirePairing();
    const document = this.requireDocument();
    await this.dependencies.publisher.publish(document, token);
    this.isPublished = true;
    this.resolvedDocument = undefined;
    this.isProven = false;
    this.proof = undefined;
    return this.snapshot();
  }

  async resolve(): Promise<WalletSnapshot> {
    const local = this.requireDocument();
    const resolved = await this.dependencies.publisher.resolve();
    if (resolved.authentication[0] !== local.authentication[0]) {
      throw new WalletStateError(
        'resolved_key_mismatch',
        'Public DID document does not contain this wallet key',
      );
    }
    this.resolvedDocument = resolved;
    this.isPublished = true;
    return this.snapshot();
  }

  async proveControl(): Promise<WalletSnapshot> {
    const secretKey = this.requireSecretKey();
    const document = this.resolvedDocument;
    if (!document) {
      throw new WalletStateError('resolution_required', 'Resolve the DID before proving control');
    }
    const now = this.dependencies.clock.nowSeconds();
    const challenge = createChallenge(await this.dependencies.random.bytes(16), now);
    const proof = signProof(
      secretKey,
      document.authentication[0],
      challenge,
      await this.dependencies.random.bytes(32),
    );
    verifyProof(proof, document, challenge, now);
    this.proof = proof;
    this.isProven = true;
    return this.snapshot();
  }

  createCredentialProof(input: {
    audience: string;
    nonce: string;
    now: number;
  }): string {
    const secretKey = this.requireSecretKey();
    const document = this.requireDocument();
    return createCredentialProof({
      secretKey,
      keyId: document.authentication[0],
      audience: input.audience,
      nonce: input.nonce,
      now: input.now,
    });
  }

  createEmployeePresentation(input: {
    credential: IssuedEmployeeCredential;
    audience: string;
    nonce: string;
    now: number;
    disclose: EmployeeClaimName[];
  }): string {
    if (input.audience !== RP_CLIENT_ID) {
      throw new WalletStateError(
        'untrusted_relying_party',
        'The relying party is not pinned for this demo',
      );
    }
    return createEmployeePresentation({
      credential: input.credential,
      holderSecret: this.requireSecretKey(),
      audience: input.audience,
      nonce: input.nonce,
      now: input.now,
      disclose: input.disclose,
    });
  }

  async rotate(): Promise<WalletSnapshot> {
    const token = this.requirePairing();
    const previousSecret = this.requireSecretKey();
    const previousDocument = this.requireDocument();
    const previousResolved = this.resolvedDocument;
    const previousProof = this.proof;
    const previousPublished = this.isPublished;
    const previousProven = this.isProven;

    const seed = await this.dependencies.random.bytes(p256.lengths.seed ?? 48);
    const { secretKey: nextSecret } = p256.keygen(seed);
    const nextDocument = this.documentForSecret(nextSecret);
    await this.dependencies.secrets.set(
      pendingPrivateKeyName,
      base64urlnopad.encode(nextSecret),
    );

    let replacedPublicDocument = false;
    try {
      await this.dependencies.publisher.publish(nextDocument, token);
      replacedPublicDocument = true;
      const resolved = await this.dependencies.publisher.resolve();
      if (resolved.authentication[0] !== nextDocument.authentication[0]) {
        throw new WalletStateError(
          'resolved_key_mismatch',
          'Rotated public DID document does not contain the new key',
        );
      }
      const now = this.dependencies.clock.nowSeconds();
      const challenge = createChallenge(await this.dependencies.random.bytes(16), now);
      const proof = signProof(
        nextSecret,
        nextDocument.authentication[0],
        challenge,
        await this.dependencies.random.bytes(32),
      );
      verifyProof(proof, resolved, challenge, now);

      await this.dependencies.secrets.set(
        privateKeyName,
        base64urlnopad.encode(nextSecret),
      );
      await this.dependencies.secrets.delete(pendingPrivateKeyName);
      this.secretKey = nextSecret;
      this.didDocument = nextDocument;
      this.resolvedDocument = resolved;
      this.proof = proof;
      this.isPublished = true;
      this.isProven = true;
      return this.snapshot();
    } catch (error) {
      if (replacedPublicDocument) {
        try {
          await this.dependencies.publisher.publish(previousDocument, token);
        } catch {
          // The error below tells the operator rotation needs attention.
        }
      }
      await this.dependencies.secrets.delete(pendingPrivateKeyName);
      this.secretKey = previousSecret;
      this.didDocument = previousDocument;
      this.resolvedDocument = previousResolved;
      this.proof = previousProof;
      this.isPublished = previousPublished;
      this.isProven = previousProven;
      throw new WalletStateError(
        'rotation_failed',
        error instanceof Error ? error.message : 'Key rotation failed',
      );
    }
  }

  async reset(): Promise<WalletSnapshot> {
    const token = this.requirePairing();
    await this.dependencies.publisher.reset(token);
    await Promise.all([
      this.dependencies.secrets.delete(privateKeyName),
      this.dependencies.secrets.delete(pairingTokenName),
    ]);
    this.pairingToken = undefined;
    this.secretKey = undefined;
    this.didDocument = undefined;
    this.resolvedDocument = undefined;
    this.proof = undefined;
    this.isPublished = false;
    this.isProven = false;
    return this.snapshot();
  }

  async revokeActiveCredential(): Promise<void> {
    const token = this.requirePairing();
    if (!this.dependencies.publisher.revokeActiveCredential) {
      throw new WalletStateError(
        'credential_lifecycle_unavailable',
        'Credential lifecycle is unavailable',
      );
    }
    await this.dependencies.publisher.revokeActiveCredential(token);
  }

  private setIdentity(secretKey: Uint8Array) {
    this.secretKey = Uint8Array.from(secretKey);
    this.didDocument = this.documentForSecret(secretKey);
    this.resolvedDocument = undefined;
    this.proof = undefined;
    this.isPublished = false;
    this.isProven = false;
  }

  private documentForSecret(secretKey: Uint8Array): DidDocument {
    const publicKey = p256.getPublicKey(secretKey, false);
    return buildDidDocument(publicJwkFromUncompressed(publicKey));
  }

  private requirePairing(): string {
    if (!this.pairingToken) {
      throw new WalletStateError('pairing_required', 'Pair with the Publisher first');
    }
    return this.pairingToken;
  }

  private requireDocument(): DidDocument {
    if (!this.didDocument) {
      throw new WalletStateError('identity_required', 'Create the controller identity first');
    }
    return this.didDocument;
  }

  private requireSecretKey(): Uint8Array {
    if (!this.secretKey) {
      throw new WalletStateError('identity_required', 'Create the controller identity first');
    }
    return this.secretKey;
  }
}
