import { ExpoRandomSource } from '../adapters/expo-random';
import { ExpoSecretStore } from '../adapters/expo-secrets';
import { HttpPublisherClient } from '../adapters/publisher-client';
import { DidControllerWallet } from '../wallet/capability';
import { CredentialVault } from '../wallet/credential-vault';
import { CredentialExchangeWallet } from '../wallet/credential-exchange';
import {
  ExpoVaultKeyStore,
  ExpoVaultRecordStore,
} from '../adapters/expo-vault';
import { PUBLIC_PROFILE } from '../config/public-profile';

export const PUBLISHER_ORIGIN = PUBLIC_PROFILE.origin;

export function createProductionWallet(): DidControllerWallet {
  return new DidControllerWallet({
    secrets: new ExpoSecretStore(),
    random: new ExpoRandomSource(),
    publisher: new HttpPublisherClient(PUBLISHER_ORIGIN),
    clock: { nowSeconds: () => Math.floor(Date.now() / 1000) },
  });
}

export function createProductionIdentityWallet() {
  const random = new ExpoRandomSource();
  const clock = { nowSeconds: () => Math.floor(Date.now() / 1000) };
  const controller = new DidControllerWallet({
    secrets: new ExpoSecretStore(),
    random,
    publisher: new HttpPublisherClient(PUBLISHER_ORIGIN),
    clock,
  });
  const vault = new CredentialVault({
    keys: new ExpoVaultKeyStore(),
    records: new ExpoVaultRecordStore(),
    random,
  });
  const exchange = new CredentialExchangeWallet({
    fetch: (url, init) => fetch(url, init),
    vault,
    identity: controller,
    clock,
    trustedOrigin: PUBLISHER_ORIGIN,
  });
  return { controller, vault, exchange };
}
