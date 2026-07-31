import {
  CredentialVault,
  type EncryptedCredentialRecord,
  type VaultKeyStore,
  type VaultRecordStore,
} from './credential-vault';

class MemoryKeys implements VaultKeyStore {
  value: string | null = null;
  async getVaultKey() {
    return this.value;
  }
  async setVaultKey(value: string) {
    this.value = value;
  }
  async removeVaultKey() {
    this.value = null;
  }
}

class MemoryRecords implements VaultRecordStore {
  records = new Map<string, EncryptedCredentialRecord>();
  async put(record: EncryptedCredentialRecord) {
    this.records.set(record.id, record);
  }
  async get(id: string) {
    return this.records.get(id) ?? null;
  }
  async list() {
    return [...this.records.values()];
  }
  async remove(id: string) {
    this.records.delete(id);
  }
  async removeAll() {
    this.records.clear();
  }
}

class SequenceRandom {
  private call = 0;
  async bytes(length: number) {
    this.call += 1;
    return Uint8Array.from(
      { length },
      (_, index) => (index + this.call * 29) % 256,
    );
  }
}

const credential = {
  id: 'employee-001',
  compact: 'issuer~disclosure~',
  issuer: 'PERURI Demo Issuer',
  type: 'Employee Credential',
  issuedAt: 1785373200,
  expiresAt: 1785978000,
  status: 'active' as const,
};

describe('encrypted credential vault seam', () => {
  test('stores only authenticated ciphertext and restores the credential', async () => {
    const keys = new MemoryKeys();
    const records = new MemoryRecords();
    const vault = new CredentialVault({
      keys,
      records,
      random: new SequenceRandom(),
    });

    await vault.save(credential);

    expect(keys.value).toBeTruthy();
    expect(keys.value).not.toContain(credential.compact);
    const raw = records.records.get(credential.id);
    expect(raw).toMatchObject({ id: credential.id, version: 1 });
    expect(JSON.stringify(raw)).not.toContain(credential.compact);
    expect(await vault.list()).toEqual([credential]);
  });

  test('rejects tampering instead of returning plaintext', async () => {
    const records = new MemoryRecords();
    const vault = new CredentialVault({
      keys: new MemoryKeys(),
      records,
      random: new SequenceRandom(),
    });
    await vault.save(credential);
    const raw = records.records.get(credential.id)!;
    records.records.set(credential.id, {
      ...raw,
      ciphertext: `${raw.ciphertext[0] === 'A' ? 'B' : 'A'}${raw.ciphertext.slice(1)}`,
    });

    await expect(vault.list()).rejects.toThrow('credential_vault_corrupt');
  });
});
