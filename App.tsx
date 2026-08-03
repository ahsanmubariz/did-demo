import { useMemo } from 'react';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { createProductionIdentityWallet } from './src/bootstrap/create-wallet';
import { IdentityWalletScreen } from './src/ui/IdentityWalletScreen';

export default function App() {
  const wallet = useMemo(() => createProductionIdentityWallet(), []);

  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      <IdentityWalletScreen
        controller={wallet.controller}
        exchange={wallet.exchange}
        vault={wallet.vault}
      />
    </SafeAreaProvider>
  );
}
