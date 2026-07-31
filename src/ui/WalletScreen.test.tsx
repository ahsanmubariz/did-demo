import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { DidDocument } from '../wallet/did-profile';
import {
  DidControllerWallet,
  type RandomSource,
  type SecretStore,
} from '../wallet/capability';
import { WalletScreen } from './WalletScreen';

class MemorySecrets implements SecretStore {
  private values = new Map<string, string>();
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string) {
    this.values.set(key, value);
  }
  async delete(key: string) {
    this.values.delete(key);
  }
}

class FixedRandom implements RandomSource {
  private call = 0;
  async bytes(length: number) {
    this.call += 1;
    return Uint8Array.from({ length }, (_, index) => (index + this.call * 23) % 256);
  }
}

class MemoryPublisher {
  document?: DidDocument;
  async publish(document: DidDocument) {
    this.document = document;
  }
  async resolve() {
    if (!this.document) throw new Error('not_found');
    return this.document;
  }
  async reset() {
    this.document = undefined;
  }
}

describe('guided wallet screen', () => {
  test('moves from pairing to a visible controller identity', async () => {
    const wallet = new DidControllerWallet({
      secrets: new MemorySecrets(),
      random: new FixedRandom(),
      publisher: new MemoryPublisher(),
      clock: { nowSeconds: () => 1785373200 },
    });
    const screen = render(<WalletScreen wallet={wallet} />);

    fireEvent.changeText(
      screen.getByPlaceholderText('Enter startup token'),
      'pair-once',
    );
    fireEvent.press(screen.getByRole('button', { name: 'Pair wallet' }));

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Create controller' })).toBeTruthy(),
    );
    fireEvent.press(screen.getByRole('button', { name: 'Create controller' }));

    await waitFor(() => {
      expect(screen.getByText('Controller key ready')).toBeTruthy();
      expect(
        screen.getByText('did:web:wallet.example.test'),
      ).toBeTruthy();
    });

    fireEvent.press(screen.getByRole('button', { name: 'Publish document' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Resolve identity' })).toBeTruthy(),
    );

    fireEvent.press(screen.getByRole('button', { name: 'Resolve identity' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Sign and verify' })).toBeTruthy(),
    );

    fireEvent.press(screen.getByRole('button', { name: 'Sign and verify' }));
    await waitFor(() => expect(screen.getByText('Control verified')).toBeTruthy());
  });
});
