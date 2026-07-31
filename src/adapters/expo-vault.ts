import * as SecureStore from 'expo-secure-store';
import * as SQLite from 'expo-sqlite';
import type {
  EncryptedCredentialRecord,
  VaultKeyStore,
  VaultRecordStore,
} from '../wallet/credential-vault';

const vaultKeyName = 'did-demo.credential-vault-key';
const secureStoreOptions: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  requireAuthentication: false,
};

export class ExpoVaultKeyStore implements VaultKeyStore {
  getVaultKey(): Promise<string | null> {
    return SecureStore.getItemAsync(vaultKeyName, secureStoreOptions);
  }

  setVaultKey(value: string): Promise<void> {
    return SecureStore.setItemAsync(vaultKeyName, value, secureStoreOptions);
  }

  removeVaultKey(): Promise<void> {
    return SecureStore.deleteItemAsync(vaultKeyName, secureStoreOptions);
  }
}

export class ExpoVaultRecordStore implements VaultRecordStore {
  private database?: Promise<SQLite.SQLiteDatabase>;

  async put(record: EncryptedCredentialRecord): Promise<void> {
    const database = await this.open();
    await database.runAsync(
      `INSERT INTO credential_vault (id, version, nonce, ciphertext)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         version = excluded.version,
         nonce = excluded.nonce,
         ciphertext = excluded.ciphertext`,
      record.id,
      record.version,
      record.nonce,
      record.ciphertext,
    );
  }

  async get(id: string): Promise<EncryptedCredentialRecord | null> {
    const database = await this.open();
    return database.getFirstAsync<EncryptedCredentialRecord>(
      `SELECT id, version, nonce, ciphertext
       FROM credential_vault WHERE id = ?`,
      id,
    );
  }

  async list(): Promise<EncryptedCredentialRecord[]> {
    const database = await this.open();
    return database.getAllAsync<EncryptedCredentialRecord>(
      `SELECT id, version, nonce, ciphertext
       FROM credential_vault ORDER BY id`,
    );
  }

  async remove(id: string): Promise<void> {
    const database = await this.open();
    await database.runAsync('DELETE FROM credential_vault WHERE id = ?', id);
  }

  async removeAll(): Promise<void> {
    const database = await this.open();
    await database.runAsync('DELETE FROM credential_vault');
  }

  private open(): Promise<SQLite.SQLiteDatabase> {
    this.database ??= SQLite.openDatabaseAsync('identity-wallet.db').then(
      async (database) => {
        await database.execAsync(`
          PRAGMA journal_mode = WAL;
          CREATE TABLE IF NOT EXISTS credential_vault (
            id TEXT PRIMARY KEY NOT NULL,
            version INTEGER NOT NULL,
            nonce TEXT NOT NULL,
            ciphertext TEXT NOT NULL
          );
        `);
        return database;
      },
    );
    return this.database;
  }
}
