/** @jest-environment jsdom */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App } from './App';

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('Credential Exchange Demo web experience', () => {
  beforeEach(() => {
    sessionStorage.clear();
    global.fetch = jest.fn(async (input, init) => {
      const url = String(input);
      if (url === '/api/operator/summary') {
        return response({
          issuedCredentials: 0,
          activeExchanges: 0,
          auditEvents: 0,
        });
      }
      if (url === '/api/operator/offers' && init?.method === 'POST') {
        return response(
          {
            id: 'offer-1',
            credentialOfferUri: 'https://demo.test/issuer/offers/offer-1',
            transactionCode: '493201',
          },
          201,
        );
      }
      return response({ error: 'not_found' }, 404);
    }) as jest.Mock;
  });

  test('unlocks issuer controls and renders a reference offer', async () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText('Operator token'), {
      target: { value: 'operator-secret' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Unlock issuer' }));
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Create credential offer' }),
      ).toBeTruthy(),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Create credential offer' }),
    );

    await waitFor(() => expect(screen.getByText('493201')).toBeTruthy());
    expect(screen.getByText('Alya Pratama')).toBeTruthy();
    expect(
      screen.getByAltText('Employee credential offer QR').getAttribute('src'),
    ).toContain('/api/qr?');
  });
});
