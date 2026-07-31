import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { base64urlnopad } from '@scure/base';

export type StoredCredential = {
  id: string;
  compact: string;
  issuer: string;
  type: string;
  issuedAt: number;
  expiresAt: number;
  status: 'active' | 'revoked' | 'expired';
};

export type EncryptedCredentialRecord = {
  id: string;
  version: 1;
  nonce: string;
  ciphertext: string;
};

export interface VaultKeyStore {
  getVaultKey(): Promise<string | null>;
  setVaultKey(value: string): Promise<void>;
  removeVaultKey(): Promise<void>;
}

export interface VaultRecordStore {
  put(record: EncryptedCredentialRecord): Promise<void>;
  get(id: string): Promise<EncryptedCredentialRecord | null>;
  list(): Promise<EncryptedCredentialRecord[]>;
  remove(id: string): Promise<void>;
  removeAll(): Promise<void>;
}

export interface VaultRandomSource {
  bytes(length: number): Promise<Uint8Array>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function associatedData(id: string): Uint8Array {
  return encoder.encode(`identity-wallet-demo:credential:v1:${id}`);
}

function parseCredential(plaintext: Uint8Array, expectedId: string): StoredCredential {
  try {
    const value = JSON.parse(decoder.decode(plaintext)) as StoredCredential;
    if (
      typeof value !== 'object' ||
      value === null ||
      value.id !== expectedId ||
      typeof value.compact !== 'string' ||
      typeof value.issuer !== 'string' ||
      typeof value.type !== 'string' ||
      !Number.isInteger(value.issuedAt) ||
      !Number.isInteger(value.expiresAt) ||
      !['active', 'revoked', 'expired'].includes(value.status)
    ) {
      throw new Error();
    }
    return value;
  } catch {
    throw new Error('credential_vault_corrupt');
  }
}

export class CredentialVault {
  private key?: Uint8Array;

  constructor(
    private readonly dependencies: {
      keys: VaultKeyStore;
      records: VaultRecordStore;
      random: VaultRandomSource;
    },
  ) {}

  async save(credential: StoredCredential): Promise<void> {
    const key = await this.requireKey();
    const nonce = await this.dependencies.random.bytes(24);
    if (nonce.length !== 24) throw new Error('credential_vault_random_failed');
    const cipher = xchacha20poly1305(key, nonce, associatedData(credential.id));
    const ciphertext = cipher.encrypt(
      encoder.encode(JSON.stringify(credential)),
    );
    await this.dependencies.records.put({
      id: credential.id,
      version: 1,
      nonce: base64urlnopad.encode(nonce),
      ciphertext: base64urlnopad.encode(ciphertext),
    });
  }

  async get(id: string): Promise<StoredCredential | null> {
    const record = await this.dependencies.records.get(id);
    return record ? this.decrypt(record) : null;
  }

  async list(): Promise<StoredCredential[]> {
    const records = await this.dependencies.records.list();
    return Promise.all(records.map((record) => this.decrypt(record)));
  }

  async remove(id: string): Promise<void> {
    await this.dependencies.records.remove(id);
  }

  lock(): void {
    if (this.key) this.key.fill(0);
    this.key = undefined;
  }

  async reset(): Promise<void> {
    await this.dependencies.records.removeAll();
    await this.dependencies.keys.removeVaultKey();
    this.lock();
  }

  private async decrypt(record: EncryptedCredentialRecord): Promise<StoredCredential> {
    try {
      if (record.version !== 1) throw new Error();
      const key = await this.requireKey();
      const nonce = base64urlnopad.decode(record.nonce);
      const ciphertext = base64urlnopad.decode(record.ciphertext);
      if (nonce.length !== 24) throw new Error();
      const plaintext = xchacha20poly1305(
        key,
        nonce,
        associatedData(record.id),
      ).decrypt(ciphertext);
      return parseCredential(plaintext, record.id);
    } catch {
      throw new Error('credential_vault_corrupt');
    }
  }

  private async requireKey(): Promise<Uint8Array> {
    if (this.key) return this.key;
    const encoded = await this.dependencies.keys.getVaultKey();
    if (encoded) {
      const restored = base64urlnopad.decode(encoded);
      if (restored.length !== 32) throw new Error('credential_vault_key_invalid');
      this.key = restored;
      return restored;
    }
    const created = await this.dependencies.random.bytes(32);
    if (created.length !== 32) throw new Error('credential_vault_random_failed');
    await this.dependencies.keys.setVaultKey(base64urlnopad.encode(created));
    this.key = Uint8Array.from(created);
    return this.key;
  }
}
