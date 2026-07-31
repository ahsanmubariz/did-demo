import { useMemo } from 'react';
import { Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useFonts } from 'expo-font';
import { Fraunces_700Bold } from '@expo-google-fonts/fraunces/700Bold';
import { IBMPlexMono_400Regular } from '@expo-google-fonts/ibm-plex-mono/400Regular';
import { IBMPlexMono_500Medium } from '@expo-google-fonts/ibm-plex-mono/500Medium';
import { IBMPlexMono_600SemiBold } from '@expo-google-fonts/ibm-plex-mono/600SemiBold';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { createProductionIdentityWallet } from './src/bootstrap/create-wallet';
import { IdentityWalletScreen } from './src/ui/IdentityWalletScreen';

export default function App() {
  const wallet = useMemo(() => createProductionIdentityWallet(), []);
  const [fontsLoaded, fontError] = useFonts({
    Fraunces_700Bold,
    IBMPlexMono_400Regular,
    IBMPlexMono_500Medium,
    IBMPlexMono_600SemiBold,
  });

  if (!fontsLoaded && !fontError) {
    return <View style={{ flex: 1, backgroundColor: '#10251f' }} />;
  }

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {fontError ? (
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#10251f',
            padding: 24,
          }}
        >
          <Text style={{ color: '#f1efdf' }}>
            Wallet fonts could not be loaded. Restart Expo Go and try again.
          </Text>
        </View>
      ) : (
        <IdentityWalletScreen
          controller={wallet.controller}
          exchange={wallet.exchange}
          vault={wallet.vault}
        />
      )}
    </SafeAreaProvider>
  );
}
