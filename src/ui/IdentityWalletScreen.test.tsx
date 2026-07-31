import { fireEvent, render, waitFor } from '@testing-library/react-native';
import type { StoredCredential } from '../wallet/credential-vault';
import { IdentityWalletScreen } from './IdentityWalletScreen';

const credential: StoredCredential = {
  id: 'employee-001',
  compact: 'issuer~disclosures~',
  issuer: 'PERURI Demo Issuer',
  type: 'Employee Credential',
  issuedAt: 1785373200,
  expiresAt: 1785978000,
  status: 'active',
};

describe('Identity Wallet product screen', () => {
  test('asks for the current Operator Token when a restored identity is disconnected', async () => {
    const disconnected = {
      did: 'did:web:wallet.example.test' as const,
      paired: true,
      hasIdentity: true,
      published: false,
      resolved: false,
      proven: false,
    };
    const screen = render(
      <IdentityWalletScreen
        controller={{
          snapshot: () => disconnected,
          restore: async () => disconnected,
          pair: jest.fn(),
          publish: jest.fn(),
          resolve: jest.fn(),
          proveControl: jest.fn(),
        }}
        exchange={{
          acceptOffer: jest.fn(),
          inspectPresentationRequest: jest.fn(),
          respondToPresentation: jest.fn(),
        }}
        vault={{ list: async () => [], lock: jest.fn() }}
      />,
    );

    await waitFor(() =>
      expect(screen.getByLabelText('Companion operator token')).toBeTruthy(),
    );
    expect(
      screen.getByRole('button', { name: 'Reconnect wallet' }),
    ).toBeTruthy();
  });

  test('shows the active credential and preserves an issuance receipt', async () => {
    const vault = {
      list: jest.fn().mockResolvedValue([credential]),
      lock: jest.fn(),
    };
    const screen = render(
      <IdentityWalletScreen
        controller={{
          snapshot: () => ({
            did: 'did:web:wallet.example.test',
            paired: true,
            hasIdentity: true,
            published: true,
            resolved: true,
            proven: true,
          }),
          restore: async () => ({
            did: 'did:web:wallet.example.test',
            paired: true,
            hasIdentity: true,
            published: true,
            resolved: true,
            proven: true,
          }),
        }}
        exchange={{
          acceptOffer: jest.fn().mockResolvedValue(credential),
          inspectPresentationRequest: jest.fn(),
          respondToPresentation: jest.fn(),
        }}
        vault={vault}
      />,
    );

    await waitFor(() => expect(screen.getByText('Employee Credential')).toBeTruthy());
    expect(screen.getByText('PERURI Demo Issuer')).toBeTruthy();
    expect(screen.getByText('ACTIVE')).toBeTruthy();

    fireEvent.press(screen.getByRole('button', { name: 'Scan' }));
    fireEvent.changeText(
      screen.getByLabelText('Credential exchange link'),
      'https://issuer.test/offer',
    );
    fireEvent.changeText(screen.getByLabelText('Transaction code'), '123456');
    fireEvent.press(screen.getByRole('button', { name: 'Accept credential' }));

    await waitFor(() =>
      expect(screen.getByText('Credential accepted')).toBeTruthy(),
    );
    fireEvent.press(screen.getByRole('button', { name: 'Activity' }));
    expect(screen.getByText('Credential accepted')).toBeTruthy();
  });
});
