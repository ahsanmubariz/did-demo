import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { WalletSnapshot } from '../wallet/capability';
import type {
  CredentialExchangeWallet,
  PresentationRequest,
} from '../wallet/credential-exchange';
import type {
  CredentialVault,
  StoredCredential,
} from '../wallet/credential-vault';

type Controller = {
  snapshot(): WalletSnapshot;
  restore(): Promise<WalletSnapshot>;
  pair?(token: string): Promise<WalletSnapshot>;
  createIdentity?(): Promise<WalletSnapshot>;
  publish?(): Promise<WalletSnapshot>;
  resolve?(): Promise<WalletSnapshot>;
  proveControl?(): Promise<WalletSnapshot>;
  rotate?(): Promise<WalletSnapshot>;
  reset?(): Promise<WalletSnapshot>;
  revokeActiveCredential?(): Promise<void>;
};

type Exchange = Pick<
  CredentialExchangeWallet,
  'acceptOffer' | 'inspectPresentationRequest' | 'respondToPresentation'
> &
  Partial<Pick<CredentialExchangeWallet, 'refreshCredentialStatus'>>;

type Props = {
  controller: Controller;
  exchange: Exchange;
  vault: Pick<CredentialVault, 'list' | 'lock'> &
    Partial<Pick<CredentialVault, 'remove' | 'reset'>>;
};

type Destination = 'wallet' | 'scan' | 'activity';
type Receipt = {
  id: string;
  title: string;
  detail: string;
  time: string;
};

const colors = {
  ink: '#10251f',
  inkSoft: '#234239',
  paper: '#f5f1e7',
  white: '#fffdf7',
  teal: '#167565',
  tealSoft: '#d7ebe4',
  amber: '#d8922b',
  muted: '#68756f',
  line: '#cbd4cf',
  red: '#a74232',
};

function message(error: unknown): string {
  return error instanceof Error
    ? error.message.replaceAll('_', ' ')
    : 'The exchange could not be completed';
}

function ReceiptRow({ receipt }: { receipt: Receipt }) {
  return (
    <View style={styles.receipt}>
      <View style={styles.receiptMark} />
      <View style={styles.receiptCopy}>
        <Text style={styles.receiptTitle}>{receipt.title}</Text>
        <Text style={styles.receiptDetail}>{receipt.detail}</Text>
      </View>
      <Text style={styles.receiptTime}>{receipt.time}</Text>
    </View>
  );
}

export function IdentityWalletScreen({ controller, exchange, vault }: Props) {
  const [snapshot, setSnapshot] = useState(() => controller.snapshot());
  const [credentials, setCredentials] = useState<StoredCredential[]>([]);
  const [destination, setDestination] = useState<Destination>('wallet');
  const [operatorToken, setOperatorToken] = useState('');
  const [exchangeLink, setExchangeLink] = useState('');
  const [transactionCode, setTransactionCode] = useState('');
  const [request, setRequest] = useState<PresentationRequest>();
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [notice, setNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);

  useEffect(() => {
    let active = true;
    Promise.all([controller.restore(), vault.list()])
      .then(([restored, stored]) => {
        if (!active) return;
        setSnapshot(restored);
        setCredentials(stored);
        if (exchange.refreshCredentialStatus && stored.length) {
          void Promise.all(
            stored.map((credential) =>
              exchange.refreshCredentialStatus!(credential),
            ),
          )
            .then((refreshed) => {
              if (active) setCredentials(refreshed);
            })
            .catch(() => {
              if (active) {
                setError('Credential status is unavailable; sharing is disabled');
              }
            });
        }
      })
      .catch((restoreError: unknown) => {
        if (active) setError(message(restoreError));
      });
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') vault.lock();
    });
    return () => {
      active = false;
      subscription.remove();
    };
  }, [controller, exchange, vault]);

  function addReceipt(title: string, detail: string) {
    setReceipts((current) =>
      [
        {
          id: `${Date.now()}-${title}`,
          title,
          detail,
          time: 'NOW',
        },
        ...current,
      ].slice(0, 50),
    );
    setNotice(title);
  }

  async function setUpWallet() {
    if (
      !controller.pair ||
      (!snapshot.hasIdentity && !controller.createIdentity) ||
      !controller.publish ||
      !controller.resolve ||
      !controller.proveControl
    ) {
      setError('Wallet setup is unavailable');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await controller.pair(operatorToken);
      if (!snapshot.hasIdentity) await controller.createIdentity!();
      await controller.publish();
      await controller.resolve();
      setSnapshot(await controller.proveControl());
      addReceipt('Wallet ready', 'DID created, published, and verified');
    } catch (setupError) {
      setError(message(setupError));
    } finally {
      setBusy(false);
    }
  }

  async function acceptCredential() {
    setBusy(true);
    setError(undefined);
    try {
      const accepted = await exchange.acceptOffer(
        exchangeLink.trim(),
        transactionCode.trim(),
      );
      setCredentials([accepted]);
      setTransactionCode('');
      setExchangeLink('');
      addReceipt('Credential accepted', 'Employee Credential · PERURI');
      setDestination('wallet');
    } catch (acceptError) {
      setError(message(acceptError));
    } finally {
      setBusy(false);
    }
  }

  async function reviewRequest() {
    setBusy(true);
    setError(undefined);
    try {
      setRequest(await exchange.inspectPresentationRequest(exchangeLink.trim()));
    } catch (requestError) {
      setError(message(requestError));
    } finally {
      setBusy(false);
    }
  }

  async function respond(approve: boolean) {
    const credential = credentials[0];
    if (!request || !credential) return;
    setBusy(true);
    setError(undefined);
    try {
      await exchange.respondToPresentation(request, credential, approve);
      addReceipt(
        approve ? 'Data shared' : 'Request denied',
        approve
          ? 'Name, employer, employment status · Partner Access Portal'
          : 'No credential data was shared',
      );
      setRequest(undefined);
      setExchangeLink('');
      setDestination('activity');
    } catch (responseError) {
      setError(message(responseError));
    } finally {
      setBusy(false);
    }
  }

  async function removeCredential(credential: StoredCredential) {
    if (!controller.revokeActiveCredential || !vault.remove) {
      setError('Credential lifecycle is unavailable');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await controller.revokeActiveCredential();
      await vault.remove(credential.id);
      setCredentials([]);
      setShowDetails(false);
      addReceipt('Credential removed', 'Issuer status changed to revoked first');
    } catch (removeError) {
      setError(message(removeError));
    } finally {
      setBusy(false);
    }
  }

  async function rotateIdentity() {
    if (!controller.rotate) return;
    setBusy(true);
    setError(undefined);
    try {
      setSnapshot(await controller.rotate());
      addReceipt('Identity key rotated', 'Public DID document verified');
    } catch (rotateError) {
      setError(message(rotateError));
    } finally {
      setBusy(false);
    }
  }

  async function resetDemo() {
    if (!controller.reset || !vault.reset) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await controller.reset();
      await vault.reset();
      setCredentials([]);
      setReceipts([]);
      setResetArmed(false);
      setSnapshot(next);
    } catch (resetError) {
      setError(message(resetError));
    } finally {
      setBusy(false);
    }
  }

  if (!snapshot.proven) {
    return (
      <SafeAreaView style={styles.onboardingSafe}>
        <View style={styles.onboarding}>
          <Text style={styles.eyebrowLight}>IDENTITY WALLET · DEMO</Text>
          <Text style={styles.onboardingTitle}>
            {snapshot.hasIdentity
              ? 'Reconnect your\nwallet.'
              : 'Your verified\nwork identity.'}
          </Text>
          <Text style={styles.onboardingBody}>
            {snapshot.hasIdentity
              ? 'Your identity key is already on this iPhone. Enter the current Companion token to publish and verify it for this session.'
              : 'Create a domain-based DID, receive one employee credential, and choose exactly what a partner can see.'}
          </Text>
          {error ? <Text accessibilityRole="alert" style={styles.errorLight}>{error}</Text> : null}
          <Text style={styles.inputLabelLight}>COMPANION OPERATOR TOKEN</Text>
          <TextInput
            accessibilityLabel="Companion operator token"
            autoCapitalize="none"
            onChangeText={setOperatorToken}
            placeholder="Paste token from workstation"
            placeholderTextColor="#8fa29b"
            secureTextEntry
            style={styles.onboardingInput}
            value={operatorToken}
          />
          <PrimaryButton
            busy={busy}
            label={snapshot.hasIdentity ? 'Reconnect wallet' : 'Create my wallet'}
            onPress={setUpWallet}
          />
          <Text style={styles.onboardingFoot}>
            P-256 key stays in iOS Keychain · no blockchain node
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.shell}>
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>IDENTITY WALLET</Text>
            <Text style={styles.headerTitle}>
              {destination === 'wallet'
                ? 'Wallet'
                : destination === 'scan'
                  ? 'Exchange'
                  : 'Activity'}
            </Text>
          </View>
          <View style={styles.didBadge}>
            <View style={styles.didDot} />
            <Text style={styles.didBadgeText}>DID READY</Text>
          </View>
        </View>

        {notice ? (
          <View accessibilityRole="alert" style={styles.notice}>
            <Text style={styles.noticeMark}>✓</Text>
            <Text style={styles.noticeText}>{notice}</Text>
          </View>
        ) : null}
        {error ? (
          <View accessibilityRole="alert" style={styles.errorBox}>
            <Text style={styles.errorText}>{error}</Text>
          </View>
        ) : null}

        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
        >
          {destination === 'wallet' ? (
            <>
              <Text style={styles.sectionLabel}>CREDENTIALS · {credentials.length}</Text>
              {credentials.length ? (
                credentials.map((credential) => (
                  <Pressable
                    accessibilityLabel="Open Employee Credential"
                    key={credential.id}
                    onPress={() => setShowDetails((value) => !value)}
                    style={({ pressed }) => [
                      styles.credential,
                      pressed && styles.pressed,
                    ]}
                  >
                    <View style={styles.credentialTop}>
                      <View style={styles.issuerSeal}>
                        <Text style={styles.issuerSealText}>P</Text>
                      </View>
                      <Text style={styles.status}>{credential.status.toUpperCase()}</Text>
                    </View>
                    <Text style={styles.credentialType}>{credential.type}</Text>
                    <Text style={styles.credentialIssuer}>{credential.issuer}</Text>
                    <View style={styles.rule} />
                    <View style={styles.credentialFooter}>
                      <View>
                        <Text style={styles.micro}>HOLDER</Text>
                        <Text style={styles.person}>Alya Pratama</Text>
                      </View>
                      <Text style={styles.chevron}>{showDetails ? '↑' : '↗'}</Text>
                    </View>
                    {showDetails ? (
                      <View style={styles.details}>
                        <Claim label="EMPLOYEE ID" value="EMP-DEMO-001" />
                        <Claim label="DEPARTMENT" value="Digital Trust Lab" />
                        <Claim label="EMPLOYER" value="PERURI" />
                        <Claim label="STATUS" value="Active" />
                        <Text style={styles.evidence}>
                          SD-JWT · ES256 · status checked online
                        </Text>
                        <Pressable
                          accessibilityLabel="Remove credential"
                          accessibilityRole="button"
                          disabled={busy}
                          onPress={() => removeCredential(credential)}
                          style={styles.cardDanger}
                        >
                          <Text style={styles.cardDangerText}>
                            REMOVE AND REVOKE
                          </Text>
                        </Pressable>
                      </View>
                    ) : null}
                  </Pressable>
                ))
              ) : (
                <View style={styles.empty}>
                  <Text style={styles.emptyTitle}>No credentials yet</Text>
                  <Text style={styles.emptyBody}>
                    Scan the offer shown by PERURI Demo Issuer to add your
                    synthetic employee credential.
                  </Text>
                  <PrimaryButton
                    label="Open scanner"
                    onPress={() => setDestination('scan')}
                  />
                </View>
              )}
              <View style={styles.identityCard}>
                <Text style={styles.sectionLabel}>HOLDER IDENTITY</Text>
                <Text numberOfLines={2} selectable style={styles.didValue}>
                  {snapshot.did}
                </Text>
                <Text style={styles.identityMeta}>
                  HTTPS domain anchored · controller proof verified
                </Text>
                <Pressable
                  accessibilityLabel="Rotate identity key"
                  accessibilityRole="button"
                  disabled={busy || credentials.length > 0}
                  onPress={rotateIdentity}
                  style={[
                    styles.inlineButton,
                    credentials.length > 0 && styles.inlineButtonDisabled,
                  ]}
                >
                  <Text style={styles.inlineButtonText}>ROTATE IDENTITY KEY</Text>
                </Pressable>
                {credentials.length > 0 ? (
                  <Text style={styles.identityMeta}>
                    Remove the active credential before rotating its holder key.
                  </Text>
                ) : null}
                {resetArmed ? (
                  <Pressable
                    accessibilityLabel="Confirm reset demo"
                    accessibilityRole="button"
                    disabled={busy}
                    onPress={resetDemo}
                    style={styles.resetButton}
                  >
                    <Text style={styles.resetText}>CONFIRM COORDINATED RESET</Text>
                  </Pressable>
                ) : (
                  <Pressable
                    accessibilityLabel="Reset demo"
                    accessibilityRole="button"
                    onPress={() => setResetArmed(true)}
                    style={styles.resetButton}
                  >
                    <Text style={styles.resetText}>RESET DEMO</Text>
                  </Pressable>
                )}
              </View>
            </>
          ) : null}

          {destination === 'scan' ? (
            request ? (
              <ConsentPanel
                busy={busy}
                onDeny={() => respond(false)}
                onShare={() => respond(true)}
                request={request}
              />
            ) : (
              <>
                <CameraPanel onScanned={setExchangeLink} />
                <Text style={styles.or}>OR PASTE A REFERENCE</Text>
                <TextInput
                  accessibilityLabel="Credential exchange link"
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={setExchangeLink}
                  placeholder="https://…/issuer/offers/…"
                  placeholderTextColor="#85928c"
                  style={styles.input}
                  value={exchangeLink}
                />
                {exchangeLink.includes('/rp/requests/') ? (
                  <PrimaryButton
                    busy={busy}
                    label="Review data request"
                    onPress={reviewRequest}
                  />
                ) : (
                  <>
                    <Text style={styles.inputLabel}>6-DIGIT TRANSACTION CODE</Text>
                    <TextInput
                      accessibilityLabel="Transaction code"
                      keyboardType="number-pad"
                      maxLength={6}
                      onChangeText={setTransactionCode}
                      placeholder="000000"
                      placeholderTextColor="#85928c"
                      style={[styles.input, styles.codeInput]}
                      value={transactionCode}
                    />
                    <PrimaryButton
                      busy={busy}
                      label="Accept credential"
                      onPress={acceptCredential}
                    />
                  </>
                )}
                <Text style={styles.helper}>
                  QR codes contain short-lived HTTPS references only. They do not
                  contain credential data.
                </Text>
              </>
            )
          ) : null}

          {destination === 'activity' ? (
            receipts.length ? (
              <>
                <Text style={styles.sectionLabel}>RECENT · ON THIS DEVICE</Text>
                {receipts.map((receipt) => (
                  <ReceiptRow key={receipt.id} receipt={receipt} />
                ))}
                <Text style={styles.helper}>
                  Activity stores outcomes and claim names only—never values,
                  proofs, or credentials.
                </Text>
              </>
            ) : (
              <View style={styles.empty}>
                <Text style={styles.emptyTitle}>Nothing shared yet</Text>
                <Text style={styles.emptyBody}>
                  Issuance, sharing, denial, and lifecycle receipts appear here.
                </Text>
              </View>
            )
          ) : null}
        </ScrollView>

        <View style={styles.nav}>
          <NavButton
            active={destination === 'wallet'}
            label="Wallet"
            mark="▰"
            onPress={() => {
              setNotice(undefined);
              setDestination('wallet');
            }}
          />
          <NavButton
            active={destination === 'scan'}
            label="Scan"
            mark="⌗"
            onPress={() => {
              setNotice(undefined);
              setDestination('scan');
            }}
          />
          <NavButton
            active={destination === 'activity'}
            label="Activity"
            mark="≡"
            onPress={() => {
              setNotice(undefined);
              setDestination('activity');
            }}
          />
        </View>
      </View>
    </SafeAreaView>
  );
}

function CameraPanel({ onScanned }: { onScanned(value: string): void }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [enabled, setEnabled] = useState(true);
  if (!permission?.granted) {
    return (
      <View style={styles.cameraPlaceholder}>
        <Text style={styles.cameraMark}>⌗</Text>
        <Text style={styles.cameraTitle}>Scan an exchange QR</Text>
        <Text style={styles.cameraBody}>
          Camera access is used only to read the reference URL.
        </Text>
        <PrimaryButton label="Allow camera" onPress={requestPermission} />
      </View>
    );
  }
  return (
    <View style={styles.cameraFrame}>
      <CameraView
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={
          enabled
            ? ({ data }) => {
                setEnabled(false);
                onScanned(data);
              }
            : undefined
        }
        style={StyleSheet.absoluteFill}
      />
      <View pointerEvents="none" style={styles.cameraGuide} />
    </View>
  );
}

function ConsentPanel({
  request,
  busy,
  onShare,
  onDeny,
}: {
  request: PresentationRequest;
  busy: boolean;
  onShare(): void;
  onDeny(): void;
}) {
  return (
    <View style={styles.consent}>
      <Text style={styles.sectionLabel}>PARTNER ACCESS PORTAL</Text>
      <Text style={styles.consentTitle}>Share employment proof?</Text>
      <Text style={styles.consentBody}>
        This verified relying party is asking for exactly three claims.
      </Text>
      {request.claims.map((claim) => (
        <View key={claim} style={styles.claimRequest}>
          <Text style={styles.claimCheck}>✓</Text>
          <Text style={styles.claimRequestText}>
            {claim.replaceAll('_', ' ')}
          </Text>
        </View>
      ))}
      <View style={styles.withheld}>
        <Text style={styles.withheldTitle}>NOT SHARED</Text>
        <Text style={styles.withheldText}>
          Email · Employee ID · Department · credential proof
        </Text>
      </View>
      <PrimaryButton busy={busy} label="Share 3 claims" onPress={onShare} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Deny request"
        disabled={busy}
        onPress={onDeny}
        style={styles.denyButton}
      >
        <Text style={styles.denyText}>DENY REQUEST</Text>
      </Pressable>
    </View>
  );
}

function Claim({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.claim}>
      <Text style={styles.claimLabel}>{label}</Text>
      <Text style={styles.claimValue}>{value}</Text>
    </View>
  );
}

function PrimaryButton({
  label,
  onPress,
  busy = false,
}: {
  label: string;
  onPress(): void;
  busy?: boolean;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => [
        styles.primaryButton,
        pressed && styles.pressed,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={colors.white} />
      ) : (
        <>
          <Text style={styles.primaryButtonText}>{label.toUpperCase()}</Text>
          <Text style={styles.primaryArrow}>→</Text>
        </>
      )}
    </Pressable>
  );
}

function NavButton({
  label,
  mark,
  active,
  onPress,
}: {
  label: string;
  mark: string;
  active: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="button"
      onPress={onPress}
      style={styles.navButton}
    >
      <Text style={[styles.navMark, active && styles.navActive]}>{mark}</Text>
      <Text style={[styles.navLabel, active && styles.navActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  shell: { flex: 1 },
  content: { padding: 20, paddingBottom: 36 },
  header: {
    alignItems: 'flex-end',
    backgroundColor: colors.ink,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: 20,
    paddingHorizontal: 20,
    paddingTop: 16,
  },
  eyebrow: {
    color: '#9fb7ae',
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 10,
    letterSpacing: 1.8,
  },
  headerTitle: {
    color: colors.white,
    fontFamily: 'Fraunces_700Bold',
    fontSize: 34,
    marginTop: 2,
  },
  didBadge: {
    alignItems: 'center',
    borderColor: '#49675d',
    borderRadius: 20,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 7,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  didDot: { backgroundColor: '#54d5ad', borderRadius: 4, height: 7, width: 7 },
  didBadgeText: {
    color: '#cbe8dd',
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 9,
    letterSpacing: 1,
  },
  notice: {
    alignItems: 'center',
    backgroundColor: colors.tealSoft,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 11,
  },
  noticeMark: { color: colors.teal, fontSize: 16, fontWeight: '700' },
  noticeText: {
    color: colors.ink,
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: 12,
  },
  errorBox: { backgroundColor: '#f5ddd8', padding: 12 },
  errorText: { color: colors.red, fontFamily: 'IBMPlexMono_500Medium', fontSize: 12 },
  sectionLabel: {
    color: colors.muted,
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 10,
    letterSpacing: 1.5,
    marginBottom: 12,
  },
  credential: {
    backgroundColor: colors.teal,
    borderRadius: 3,
    minHeight: 242,
    padding: 22,
    shadowColor: '#0b2f27',
    shadowOffset: { height: 8, width: 0 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
  },
  credentialTop: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  issuerSeal: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderRadius: 22,
    height: 43,
    justifyContent: 'center',
    width: 43,
  },
  issuerSealText: {
    color: colors.teal,
    fontFamily: 'Fraunces_700Bold',
    fontSize: 24,
  },
  status: {
    backgroundColor: '#0c5d50',
    borderRadius: 2,
    color: '#d8fff2',
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 9,
    letterSpacing: 1.2,
    paddingHorizontal: 9,
    paddingVertical: 6,
  },
  credentialType: {
    color: colors.white,
    fontFamily: 'Fraunces_700Bold',
    fontSize: 29,
    marginTop: 30,
  },
  credentialIssuer: {
    color: '#c7e8dd',
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: 11,
    marginTop: 6,
  },
  rule: { backgroundColor: '#69a99b', height: 1, marginVertical: 19 },
  credentialFooter: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  micro: {
    color: '#aad2c7',
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 8,
    letterSpacing: 1.4,
  },
  person: {
    color: colors.white,
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: 14,
    marginTop: 4,
  },
  chevron: { color: colors.white, fontSize: 22 },
  details: {
    borderTopColor: '#69a99b',
    borderTopWidth: 1,
    marginTop: 18,
    paddingTop: 12,
  },
  claim: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingVertical: 7,
  },
  claimLabel: {
    color: '#acd3c8',
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: 9,
  },
  claimValue: {
    color: colors.white,
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: 11,
  },
  evidence: {
    color: '#9dcabe',
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 9,
    marginTop: 10,
  },
  cardDanger: {
    alignItems: 'center',
    borderColor: '#9bc5ba',
    borderWidth: 1,
    justifyContent: 'center',
    marginTop: 18,
    minHeight: 44,
  },
  cardDangerText: {
    color: colors.white,
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 9,
    letterSpacing: 1.1,
  },
  identityCard: {
    borderColor: colors.line,
    borderWidth: 1,
    marginTop: 24,
    padding: 17,
  },
  didValue: {
    color: colors.ink,
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: 11,
    lineHeight: 17,
  },
  identityMeta: {
    color: colors.muted,
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 9,
    marginTop: 9,
  },
  inlineButton: {
    alignItems: 'center',
    borderColor: colors.ink,
    borderWidth: 1,
    justifyContent: 'center',
    marginTop: 16,
    minHeight: 44,
  },
  inlineButtonDisabled: { opacity: 0.35 },
  inlineButtonText: {
    color: colors.ink,
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 9,
    letterSpacing: 1.1,
  },
  resetButton: {
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 8,
    minHeight: 44,
  },
  resetText: {
    color: colors.red,
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 9,
    letterSpacing: 1.1,
  },
  empty: {
    alignItems: 'flex-start',
    borderColor: colors.line,
    borderWidth: 1,
    padding: 24,
  },
  emptyTitle: {
    color: colors.ink,
    fontFamily: 'Fraunces_700Bold',
    fontSize: 26,
  },
  emptyBody: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 20,
    marginTop: 8,
  },
  primaryButton: {
    alignItems: 'center',
    backgroundColor: colors.ink,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 52,
    paddingHorizontal: 17,
    width: '100%',
  },
  primaryButtonText: {
    color: colors.white,
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 11,
    letterSpacing: 1.2,
  },
  primaryArrow: { color: colors.white, fontSize: 20 },
  input: {
    backgroundColor: colors.white,
    borderColor: colors.line,
    borderWidth: 1,
    color: colors.ink,
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 12,
    minHeight: 54,
    paddingHorizontal: 14,
  },
  inputLabel: {
    color: colors.muted,
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 9,
    letterSpacing: 1.3,
    marginBottom: 8,
    marginTop: 18,
  },
  codeInput: { fontSize: 22, letterSpacing: 8, marginBottom: 12, textAlign: 'center' },
  or: {
    color: colors.muted,
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 9,
    letterSpacing: 1.5,
    marginBottom: 9,
    marginTop: 20,
    textAlign: 'center',
  },
  helper: {
    color: colors.muted,
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 10,
    lineHeight: 16,
    marginTop: 16,
  },
  cameraPlaceholder: {
    alignItems: 'center',
    backgroundColor: colors.inkSoft,
    minHeight: 235,
    padding: 28,
  },
  cameraMark: { color: '#8ed8c2', fontSize: 42 },
  cameraTitle: {
    color: colors.white,
    fontFamily: 'Fraunces_700Bold',
    fontSize: 22,
    marginTop: 8,
  },
  cameraBody: {
    color: '#b9c9c3',
    fontSize: 12,
    lineHeight: 18,
    marginBottom: 20,
    marginTop: 7,
    textAlign: 'center',
  },
  cameraFrame: {
    backgroundColor: colors.ink,
    height: 280,
    overflow: 'hidden',
  },
  cameraGuide: {
    borderColor: colors.white,
    borderWidth: 2,
    bottom: 44,
    left: 44,
    position: 'absolute',
    right: 44,
    top: 44,
  },
  consent: { paddingTop: 4 },
  consentTitle: {
    color: colors.ink,
    fontFamily: 'Fraunces_700Bold',
    fontSize: 34,
    lineHeight: 38,
  },
  consentBody: {
    color: colors.muted,
    fontSize: 14,
    lineHeight: 21,
    marginBottom: 20,
    marginTop: 8,
  },
  claimRequest: {
    alignItems: 'center',
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    gap: 12,
    minHeight: 48,
  },
  claimCheck: { color: colors.teal, fontSize: 16, fontWeight: '700' },
  claimRequestText: {
    color: colors.ink,
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: 13,
    textTransform: 'capitalize',
  },
  withheld: {
    backgroundColor: '#e8e4da',
    marginBottom: 18,
    marginTop: 18,
    padding: 14,
  },
  withheldTitle: {
    color: colors.muted,
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 9,
    letterSpacing: 1.2,
  },
  withheldText: {
    color: colors.inkSoft,
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 11,
    lineHeight: 17,
    marginTop: 5,
  },
  denyButton: { alignItems: 'center', minHeight: 48, justifyContent: 'center' },
  denyText: {
    color: colors.red,
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 10,
    letterSpacing: 1.2,
  },
  receipt: {
    alignItems: 'flex-start',
    borderBottomColor: colors.line,
    borderBottomWidth: 1,
    flexDirection: 'row',
    paddingVertical: 16,
  },
  receiptMark: {
    backgroundColor: colors.teal,
    borderRadius: 5,
    height: 9,
    marginRight: 12,
    marginTop: 5,
    width: 9,
  },
  receiptCopy: { flex: 1 },
  receiptTitle: {
    color: colors.ink,
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 12,
  },
  receiptDetail: {
    color: colors.muted,
    fontSize: 11,
    lineHeight: 17,
    marginTop: 4,
  },
  receiptTime: {
    color: colors.muted,
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: 8,
  },
  nav: {
    backgroundColor: colors.white,
    borderTopColor: colors.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    minHeight: 68,
  },
  navButton: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    minHeight: 54,
  },
  navMark: { color: '#87928d', fontSize: 17 },
  navLabel: {
    color: '#87928d',
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: 9,
    marginTop: 3,
  },
  navActive: { color: colors.teal },
  pressed: { opacity: 0.75 },
  onboardingSafe: { backgroundColor: colors.ink, flex: 1 },
  onboarding: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  eyebrowLight: {
    color: '#88b5a7',
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 10,
    letterSpacing: 1.8,
  },
  onboardingTitle: {
    color: colors.white,
    fontFamily: 'Fraunces_700Bold',
    fontSize: 46,
    lineHeight: 49,
    marginTop: 16,
  },
  onboardingBody: {
    color: '#b7c8c1',
    fontSize: 15,
    lineHeight: 23,
    marginBottom: 34,
    marginTop: 16,
  },
  inputLabelLight: {
    color: '#9fb4ac',
    fontFamily: 'IBMPlexMono_600SemiBold',
    fontSize: 9,
    letterSpacing: 1.2,
    marginBottom: 8,
  },
  onboardingInput: {
    borderColor: '#47645a',
    borderWidth: 1,
    color: colors.white,
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 12,
    marginBottom: 12,
    minHeight: 54,
    paddingHorizontal: 14,
  },
  onboardingFoot: {
    color: '#7f9990',
    fontFamily: 'IBMPlexMono_400Regular',
    fontSize: 9,
    lineHeight: 15,
    marginTop: 18,
    textAlign: 'center',
  },
  errorLight: {
    color: '#ffb4a5',
    fontFamily: 'IBMPlexMono_500Medium',
    fontSize: 11,
    marginBottom: 14,
  },
});
