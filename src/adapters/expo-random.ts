import * as Crypto from 'expo-crypto';
import type { RandomSource } from '../wallet/capability';

export class ExpoRandomSource implements RandomSource {
  async bytes(length: number): Promise<Uint8Array> {
    return Crypto.getRandomBytesAsync(length);
  }
}
