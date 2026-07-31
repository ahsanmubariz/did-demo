import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import {
  DidControllerWallet,
  type WalletSnapshot,
} from '../wallet/capability';

type WalletScreenProps = {
  wallet: DidControllerWallet;
};

type OperationState = 'complete' | 'active' | 'blocked' | 'available';

type Operation = {
  number: string;
  label: string;
  title: string;
  detail: string;
  state: OperationState;
};

const colors = {
  ink: '#081511',
  inkSoft: '#24342e',
  paper: '#f1efdf',
  paperBright: '#fffdf2',
  line: '#bac2b8',
  muted: '#657269',
  orange: '#f15b35',
  green: '#b9f55b',
  red: '#b93624',
};

function statusFor(condition: boolean, active: boolean): OperationState {
  if (condition) return 'complete';
  return active ? 'active' : 'blocked';
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.replaceAll('_', ' ');
  return 'The operation failed';
}

export function WalletScreen({ wallet }: WalletScreenProps) {
  const [snapshot, setSnapshot] = useState<WalletSnapshot>(() => wallet.snapshot());
  const [pairingToken, setPairingToken] = useState('');
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [evidence, setEvidence] = useState<'document' | 'proof'>();
  const [resetArmed, setResetArmed] = useState(false);

  useEffect(() => {
    let mounted = true;
    wallet
      .restore()
      .then((next) => {
        if (mounted) setSnapshot(next);
      })
      .catch((restoreError: unknown) => {
        if (mounted) setError(errorMessage(restoreError));
      });
    return () => {
      mounted = false;
    };
  }, [wallet]);

  const operations = useMemo<Operation[]>(
    () => [
      {
        number: '01',
        label: 'PAIR',
        title: snapshot.paired ? 'Publisher paired' : 'Connect Publisher',
        detail: snapshot.paired
          ? 'Process token is stored in iOS Keychain.'
          : 'Enter the one-time token printed by the workstation.',
        state: statusFor(snapshot.paired, !snapshot.paired),
      },
      {
        number: '02',
        label: 'CREATE',
        title: snapshot.hasIdentity ? 'Controller key ready' : 'Create controller',
        detail: snapshot.hasIdentity
          ? 'P-256 private key remains on this iPhone.'
          : 'Generate the signing key that controls the public DID.',
        state: statusFor(snapshot.hasIdentity, snapshot.paired),
      },
      {
        number: '03',
        label: 'PUBLISH',
        title: snapshot.published ? 'Document published' : 'Publish DID document',
        detail: snapshot.published
          ? 'The Publisher accepted this public key.'
          : 'Send public material through the paired HTTPS Publisher.',
        state: statusFor(snapshot.published, snapshot.hasIdentity),
      },
      {
        number: '04',
        label: 'RESOLVE',
        title: snapshot.resolved ? 'Public identity resolved' : 'Resolve public identity',
        detail: snapshot.resolved
          ? 'The fetched key matches this wallet.'
          : 'Fetch did.json independently through the public route.',
        state: statusFor(snapshot.resolved, snapshot.published),
      },
      {
        number: '05',
        label: 'PROVE',
        title: snapshot.proven ? 'Control verified' : 'Prove key control',
        detail: snapshot.proven
          ? 'A fresh ES256 challenge verified with the resolved key.'
          : 'Sign a two-minute nonce and verify it against did.json.',
        state: statusFor(snapshot.proven, snapshot.resolved),
      },
      {
        number: '06',
        label: 'ROTATE',
        title: 'Rotate controller key',
        detail: 'Replace the key without changing the DID; roll back on failure.',
        state: snapshot.proven ? 'available' : 'blocked',
      },
      {
        number: '07',
        label: 'RESET',
        title: 'Reset demonstration',
        detail: 'Remove the public document, pairing token, and local controller key.',
        state: snapshot.hasIdentity || snapshot.paired ? 'available' : 'blocked',
      },
    ],
    [snapshot],
  );

  async function execute(label: string, action: () => Promise<WalletSnapshot>) {
    setBusy(label);
    setError(undefined);
    try {
      setSnapshot(await action());
    } catch (operationError) {
      setError(errorMessage(operationError));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView
        contentContainerStyle={styles.page}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.masthead}>
          <View style={styles.mastheadMeta}>
            <Text style={styles.kicker}>CONTROL LOG / IPHONE</Text>
            <View style={styles.liveBadge}>
              <View style={styles.liveDot} />
              <Text style={styles.liveLabel}>DID:WEB</Text>
            </View>
          </View>
          <Text style={styles.title}>DID field{'\n'}wallet</Text>
          <Text style={styles.did} selectable>
            {snapshot.did}
          </Text>
          <View style={styles.route}>
            <Text style={styles.routeLabel}>PUBLIC ROUTE</Text>
            <Text style={styles.routeValue}>NGROK HTTPS → 127.0.0.1:8787</Text>
          </View>
        </View>

        {error ? (
          <View accessibilityRole="alert" style={styles.error}>
            <Text style={styles.errorMark}>!</Text>
            <View style={styles.errorCopy}>
              <Text style={styles.errorTitle}>OPERATION INTERRUPTED</Text>
              <Text style={styles.errorDetail}>{error}</Text>
            </View>
          </View>
        ) : null}

        <View style={styles.log}>
          {operations.map((operation) => (
            <View key={operation.number} style={styles.operation}>
              <View style={styles.rail}>
                <Text style={styles.number}>{operation.number}</Text>
                <View
                  style={[
                    styles.railDot,
                    operation.state === 'complete' && styles.railDotComplete,
                    operation.state === 'active' && styles.railDotActive,
                    operation.state === 'available' && styles.railDotAvailable,
                  ]}
                />
                {operation.number !== '07' ? <View style={styles.railLine} /> : null}
              </View>
              <View
                style={[
                  styles.operationBody,
                  operation.state === 'active' && styles.operationBodyActive,
                ]}
              >
                <View style={styles.operationHeader}>
                  <Text style={styles.operationLabel}>{operation.label}</Text>
                  <Text
                    style={[
                      styles.operationStatus,
                      operation.state === 'complete' && styles.completeText,
                    ]}
                  >
                    {operation.state.toUpperCase()}
                  </Text>
                </View>
                <Text style={styles.operationTitle}>{operation.title}</Text>
                <Text style={styles.operationDetail}>{operation.detail}</Text>

                {operation.label === 'PAIR' && operation.state === 'active' ? (
                  <View style={styles.actionArea}>
                    <TextInput
                      accessibilityLabel="Publisher pairing token"
                      autoCapitalize="none"
                      autoCorrect={false}
                      onChangeText={setPairingToken}
                      placeholder="Enter startup token"
                      placeholderTextColor="#89948d"
                      secureTextEntry
                      style={styles.input}
                      value={pairingToken}
                    />
                    <ActionButton
                      busy={busy === 'PAIR'}
                      label="Pair wallet"
                      onPress={() =>
                        execute('PAIR', () => wallet.pair(pairingToken))
                      }
                    />
                  </View>
                ) : null}

                {operation.label === 'CREATE' && operation.state === 'active' ? (
                  <ActionButton
                    busy={busy === 'CREATE'}
                    label="Create controller"
                    onPress={() => execute('CREATE', () => wallet.createIdentity())}
                  />
                ) : null}

                {operation.label === 'PUBLISH' && operation.state === 'active' ? (
                  <ActionButton
                    busy={busy === 'PUBLISH'}
                    label="Publish document"
                    onPress={() => execute('PUBLISH', () => wallet.publish())}
                  />
                ) : null}

                {operation.label === 'RESOLVE' && operation.state === 'active' ? (
                  <ActionButton
                    busy={busy === 'RESOLVE'}
                    label="Resolve identity"
                    onPress={() => execute('RESOLVE', () => wallet.resolve())}
                  />
                ) : null}

                {operation.label === 'PROVE' && operation.state === 'active' ? (
                  <ActionButton
                    busy={busy === 'PROVE'}
                    label="Sign and verify"
                    onPress={() => execute('PROVE', () => wallet.proveControl())}
                  />
                ) : null}

                {operation.label === 'ROTATE' && operation.state === 'available' ? (
                  <ActionButton
                    busy={busy === 'ROTATE'}
                    label="Rotate key"
                    onPress={() => execute('ROTATE', () => wallet.rotate())}
                    secondary
                  />
                ) : null}

                {operation.label === 'RESET' && operation.state === 'available' ? (
                  resetArmed ? (
                    <ActionButton
                      busy={busy === 'RESET'}
                      destructive
                      label="Confirm reset"
                      onPress={() =>
                        execute('RESET', async () => {
                          const next = await wallet.reset();
                          setPairingToken('');
                          setEvidence(undefined);
                          setResetArmed(false);
                          return next;
                        })
                      }
                    />
                  ) : (
                    <ActionButton
                      label="Arm reset"
                      onPress={() => setResetArmed(true)}
                      secondary
                    />
                  )
                ) : null}

                {operation.label === 'CREATE' && snapshot.keyId ? (
                  <EvidenceLine label="KEY ID" value={snapshot.keyId} />
                ) : null}
              </View>
            </View>
          ))}
        </View>

        {snapshot.didDocument ? (
          <EvidencePanel
            expanded={evidence === 'document'}
            label="DID DOCUMENT"
            onPress={() =>
              setEvidence((current) =>
                current === 'document' ? undefined : 'document',
              )
            }
            value={JSON.stringify(snapshot.resolvedDocument ?? snapshot.didDocument, null, 2)}
          />
        ) : null}

        {snapshot.proof ? (
          <EvidencePanel
            expanded={evidence === 'proof'}
            label="COMPACT DID-AUTH JWS"
            onPress={() =>
              setEvidence((current) => (current === 'proof' ? undefined : 'proof'))
            }
            value={snapshot.proof}
          />
        ) : null}

        <View style={styles.footer}>
          <Text style={styles.footerMark}>NO CHAIN / NO NODE</Text>
          <Text style={styles.footerText}>
            Control is anchored to the HTTPS domain and the key held by this wallet.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

type ActionButtonProps = {
  label: string;
  onPress(): void;
  busy?: boolean;
  secondary?: boolean;
  destructive?: boolean;
};

function ActionButton({
  label,
  onPress,
  busy = false,
  secondary = false,
  destructive = false,
}: ActionButtonProps) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        secondary && styles.buttonSecondary,
        destructive && styles.buttonDestructive,
        pressed && styles.buttonPressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={secondary ? colors.ink : colors.paperBright} />
      ) : (
        <>
          <Text
            style={[
              styles.buttonText,
              secondary && styles.buttonTextSecondary,
            ]}
          >
            {label.toUpperCase()}
          </Text>
          <Text
            style={[
              styles.buttonArrow,
              secondary && styles.buttonTextSecondary,
            ]}
          >
            ↗
          </Text>
        </>
      )}
    </Pressable>
  );
}

function EvidenceLine({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.evidenceLine}>
      <Text style={styles.evidenceLineLabel}>{label}</Text>
      <Text numberOfLines={2} selectable style={styles.evidenceLineValue}>
        {value}
      </Text>
    </View>
  );
}

function EvidencePanel({
  expanded,
  label,
  onPress,
  value,
}: {
  expanded: boolean;
  label: string;
  onPress(): void;
  value: string;
}) {
  return (
    <View style={styles.evidencePanel}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${expanded ? 'Hide' : 'Inspect'} ${label.toLowerCase()}`}
        onPress={onPress}
        style={styles.evidenceToggle}
      >
        <Text style={styles.evidenceLabel}>{label}</Text>
        <Text style={styles.evidenceSymbol}>{expanded ? '−' : '+'}</Text>
      </Pressable>
      {expanded ? (
        <Text selectable style={styles.code}>
          {value}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.ink },
  page: { backgroundColor: colors.paper, paddingBottom: 48 },
  masthead: { backgroundColor: colors.ink, paddingHorizontal: 22, paddingTop: 24, paddingBottom: 26 },
  mastheadMeta: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  kicker: { color: '#829189', fontFamily: 'IBMPlexMono_500Medium', fontSize: 9, letterSpacing: 1.8 },
  liveBadge: { flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: colors.inkSoft, paddingHorizontal: 9, paddingVertical: 6 },
  liveDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.green, marginRight: 7 },
  liveLabel: { color: colors.paper, fontFamily: 'IBMPlexMono_600SemiBold', fontSize: 9, letterSpacing: 1.2 },
  title: { color: colors.paperBright, fontFamily: 'Fraunces_700Bold', fontSize: 54, lineHeight: 50, marginTop: 25 },
  did: { color: colors.green, fontFamily: 'IBMPlexMono_400Regular', fontSize: 10, lineHeight: 16, marginTop: 20 },
  route: { borderTopWidth: 1, borderColor: colors.inkSoft, marginTop: 20, paddingTop: 13, flexDirection: 'row', justifyContent: 'space-between' },
  routeLabel: { color: '#829189', fontFamily: 'IBMPlexMono_500Medium', fontSize: 8, letterSpacing: 1.5 },
  routeValue: { color: colors.paper, fontFamily: 'IBMPlexMono_400Regular', fontSize: 8 },
  error: { margin: 18, marginBottom: 0, backgroundColor: '#f6d7cc', borderLeftWidth: 4, borderColor: colors.red, padding: 14, flexDirection: 'row' },
  errorMark: { color: colors.red, fontFamily: 'Fraunces_700Bold', fontSize: 30, marginRight: 12 },
  errorCopy: { flex: 1 },
  errorTitle: { color: colors.red, fontFamily: 'IBMPlexMono_600SemiBold', fontSize: 9, letterSpacing: 1.2 },
  errorDetail: { color: colors.ink, fontFamily: 'IBMPlexMono_400Regular', fontSize: 11, lineHeight: 17, marginTop: 5, textTransform: 'uppercase' },
  log: { paddingHorizontal: 18, paddingTop: 24 },
  operation: { flexDirection: 'row' },
  rail: { width: 43, alignItems: 'center' },
  number: { color: colors.muted, fontFamily: 'IBMPlexMono_500Medium', fontSize: 9 },
  railDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.line, marginTop: 12 },
  railDotComplete: { backgroundColor: colors.green, borderWidth: 2, borderColor: colors.ink, width: 12, height: 12, borderRadius: 6 },
  railDotActive: { backgroundColor: colors.orange, width: 14, height: 14, borderRadius: 7 },
  railDotAvailable: { backgroundColor: colors.paper, borderWidth: 2, borderColor: colors.ink, width: 12, height: 12, borderRadius: 6 },
  railLine: { flex: 1, width: 1, backgroundColor: colors.line, minHeight: 35 },
  operationBody: { flex: 1, borderTopWidth: 1, borderColor: colors.line, paddingTop: 12, paddingBottom: 22, paddingHorizontal: 4 },
  operationBodyActive: { backgroundColor: colors.paperBright, borderTopWidth: 3, borderColor: colors.ink, padding: 15, marginBottom: 14 },
  operationHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  operationLabel: { color: colors.ink, fontFamily: 'IBMPlexMono_600SemiBold', fontSize: 10, letterSpacing: 2 },
  operationStatus: { color: colors.muted, fontFamily: 'IBMPlexMono_500Medium', fontSize: 8, letterSpacing: 1 },
  completeText: { color: '#517418' },
  operationTitle: { color: colors.ink, fontFamily: 'Fraunces_700Bold', fontSize: 21, marginTop: 8 },
  operationDetail: { color: colors.muted, fontFamily: 'IBMPlexMono_400Regular', fontSize: 10, lineHeight: 16, marginTop: 7 },
  actionArea: { marginTop: 16 },
  input: { minHeight: 50, borderWidth: 1, borderColor: colors.ink, backgroundColor: colors.paper, color: colors.ink, fontFamily: 'IBMPlexMono_400Regular', fontSize: 12, paddingHorizontal: 13, marginBottom: 10 },
  button: { minHeight: 50, backgroundColor: colors.orange, paddingHorizontal: 16, marginTop: 15, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  buttonSecondary: { backgroundColor: 'transparent', borderWidth: 1, borderColor: colors.ink },
  buttonDestructive: { backgroundColor: colors.red },
  buttonPressed: { opacity: 0.72 },
  buttonText: { color: colors.paperBright, fontFamily: 'IBMPlexMono_600SemiBold', fontSize: 10, letterSpacing: 1.5 },
  buttonTextSecondary: { color: colors.ink },
  buttonArrow: { color: colors.paperBright, fontSize: 16 },
  evidenceLine: { borderLeftWidth: 2, borderColor: colors.line, paddingLeft: 10, marginTop: 14 },
  evidenceLineLabel: { color: colors.muted, fontFamily: 'IBMPlexMono_500Medium', fontSize: 8, letterSpacing: 1.2 },
  evidenceLineValue: { color: colors.ink, fontFamily: 'IBMPlexMono_400Regular', fontSize: 9, lineHeight: 14, marginTop: 5 },
  evidencePanel: { marginHorizontal: 18, marginTop: 12, backgroundColor: colors.ink },
  evidenceToggle: { minHeight: 54, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  evidenceLabel: { color: colors.green, fontFamily: 'IBMPlexMono_600SemiBold', fontSize: 9, letterSpacing: 1.5 },
  evidenceSymbol: { color: colors.paper, fontSize: 22 },
  code: { color: '#b7c6bd', borderTopWidth: 1, borderColor: colors.inkSoft, padding: 16, fontFamily: 'IBMPlexMono_400Regular', fontSize: 9, lineHeight: 15 },
  footer: { margin: 18, marginTop: 34, borderTopWidth: 1, borderColor: colors.line, paddingTop: 18 },
  footerMark: { color: colors.orange, fontFamily: 'IBMPlexMono_600SemiBold', fontSize: 9, letterSpacing: 1.5 },
  footerText: { color: colors.muted, fontFamily: 'IBMPlexMono_400Regular', fontSize: 9, lineHeight: 15, marginTop: 8 },
});
