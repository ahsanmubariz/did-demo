import * as SecureStore from 'expo-secure-store';
import type { SecretStore } from '../wallet/capability';

const options: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  requireAuthentication: false,
};

export class ExpoSecretStore implements SecretStore {
  get(key: string): Promise<string | null> {
    return SecureStore.getItemAsync(key, options);
  }

  set(key: string, value: string): Promise<void> {
    return SecureStore.setItemAsync(key, value, options);
  }

  delete(key: string): Promise<void> {
    return SecureStore.deleteItemAsync(key, options);
  }
}
