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
  ink: '#10233f',
  inkSoft: '#183a69',
  paper: '#f4f7fb',
  white: '#ffffff',
  teal: '#166c5b',
  tealSoft: '#dff5ed',
  amber: '#2d63e2',
  muted: '#52627a',
  line: '#d9e1ec',
  red: '#b42318',
  blue: '#2d63e2',
  blueDark: '#1746b5',
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
      addReceipt('Credential accepted', 'Employee Credential · DUMMY-CORP');
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
          <View style={styles.onboardingBrand}>
            <Text style={styles.onboardingBrandName}>Identity Wallet</Text>
            <Text style={styles.demoBadge}>DEMO</Text>
          </View>
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
            placeholderTextColor="#66758a"
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
            <View style={styles.productLine}>
              <Text style={styles.productName}>Identity Wallet</Text>
              <Text style={styles.demoBadge}>DEMO</Text>
            </View>
            <Text style={styles.headerTitle}>
              {destination === 'wallet'
                ? 'Wallet'
                : destination === 'scan'
                  ? 'Exchange'
                  : 'Activity'}
            </Text>
          </View>
          <View accessibilityLabel="Mock holder identity Alya Pratama" style={styles.holderAvatar}>
            <Text style={styles.holderAvatarText}>AP</Text>
          </View>
        </View>

        {notice ? (
          <View accessibilityRole="alert" style={styles.notice}>
            <View aria-hidden style={styles.noticeMark} />
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
                  <View key={credential.id} style={styles.passStack}>
                    <View aria-hidden style={styles.credentialBack} />
                    <Pressable
                      accessibilityLabel="Open Employee Credential"
                      onPress={() => setShowDetails((value) => !value)}
                      style={({ pressed }) => [
                        styles.credential,
                        pressed && styles.pressed,
                      ]}
                    >
                    <View style={styles.credentialTop}>
                      <View style={styles.issuerSeal}>
                        <Text style={styles.issuerSealText}>ID</Text>
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
                      <Text style={styles.detailsLabel}>{showDetails ? 'Close' : 'Details'}</Text>
                    </View>
                      {showDetails ? (
                      <View style={styles.details}>
                        <Claim label="EMPLOYEE ID" value="EMP-DEMO-001" />
                        <Claim label="DEPARTMENT" value="Digital Trust Lab" />
                        <Claim label="EMPLOYER" value="DUMMY-CORP" />
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
                  </View>
                ))
              ) : (
                <View style={styles.empty}>
                  <Text style={styles.emptyTitle}>No credentials yet</Text>
                  <Text style={styles.emptyBody}>
                    Scan the offer shown by DUMMY-CORP Demo Issuer to add your
                    synthetic employee credential.
                  </Text>
                  <PrimaryButton
                    label="Open scanner"
                    onPress={() => setDestination('scan')}
                  />
                </View>
              )}
              <Pressable
                accessibilityLabel="Scan a code"
                accessibilityRole="button"
                onPress={() => setDestination('scan')}
                style={({ pressed }) => [styles.scanShortcut, pressed && styles.pressed]}
              >
                <View aria-hidden style={styles.scanGlyph}>
                  <View style={styles.scanGlyphInner} />
                </View>
                <Text style={styles.scanShortcutText}>Scan a code</Text>
              </Pressable>
              <View style={styles.identityCard}>
                <View style={styles.identityHeading}>
                  <View style={styles.identityAvatarSmall}>
                    <Text style={styles.identityAvatarSmallText}>AP</Text>
                  </View>
                  <View style={styles.identityHeadingCopy}>
                    <Text style={styles.identityTitle}>Alya Pratama</Text>
                    <Text style={styles.identityMeta}>Mock holder identity · DID ready</Text>
                  </View>
                </View>
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
                  placeholderTextColor="#66758a"
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
                      placeholderTextColor="#66758a"
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
            kind="wallet"
            onPress={() => {
              setNotice(undefined);
              setDestination('wallet');
            }}
          />
          <NavButton
            active={destination === 'scan'}
            label="Scan"
            kind="scan"
            onPress={() => {
              setNotice(undefined);
              setDestination('scan');
            }}
          />
          <NavButton
            active={destination === 'activity'}
            label="Activity"
            kind="activity"
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
        <View aria-hidden style={styles.cameraIcon}>
          <View style={styles.cameraIconCore} />
        </View>
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
      <Text style={styles.consentTitle}>Share employment proof?</Text>
      <Text style={styles.consentBody}>
        This verified relying party is asking for exactly three claims.
      </Text>
      {request.claims.map((claim) => (
        <View key={claim} style={styles.claimRequest}>
          <View aria-hidden style={styles.claimCheck} />
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
        <Text style={styles.primaryButtonText}>{label}</Text>
      )}
    </Pressable>
  );
}

function NavButton({
  label,
  kind,
  active,
  onPress,
}: {
  label: string;
  kind: 'wallet' | 'scan' | 'activity';
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
      <View
        aria-hidden
        style={[
          styles.navIcon,
          kind === 'scan' && styles.navIconScan,
          kind === 'activity' && styles.navIconActivity,
          active && styles.navIconActive,
        ]}
      >
        {kind === 'wallet' ? <View style={[styles.walletIconLine, active && styles.walletIconLineActive]} /> : null}
        {kind === 'scan' ? <View style={[styles.scanIconCore, active && styles.scanIconCoreActive]} /> : null}
        {kind === 'activity' ? <View style={[styles.clockHand, active && styles.clockHandActive]} /> : null}
      </View>
      <Text style={[styles.navLabel, active && styles.navActive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.paper },
  shell: { flex: 1 },
  content: { padding: 20, paddingBottom: 32 },
  header: {
    alignItems: 'center',
    backgroundColor: colors.white,
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingBottom: 14,
    paddingHorizontal: 20,
    paddingTop: 10,
  },
  productLine: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  productName: { color: colors.ink, fontSize: 13, fontWeight: '600' },
  demoBadge: {
    backgroundColor: '#e8efff',
    borderRadius: 6,
    color: colors.blueDark,
    fontSize: 10,
    fontWeight: '700',
    overflow: 'hidden',
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  headerTitle: {
    color: colors.ink,
    fontSize: 34,
    fontWeight: '700',
    letterSpacing: -0.8,
    marginTop: 5,
  },
  holderAvatar: {
    alignItems: 'center',
    backgroundColor: '#e6edfb',
    borderRadius: 22,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  holderAvatarText: { color: colors.blueDark, fontSize: 14, fontWeight: '700' },
  notice: {
    alignItems: 'center',
    backgroundColor: colors.tealSoft,
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 20,
    paddingVertical: 11,
  },
  noticeMark: { backgroundColor: colors.teal, borderRadius: 5, height: 10, width: 10 },
  noticeText: {
    color: colors.ink,
    fontSize: 12,
  },
  errorBox: { backgroundColor: '#f5ddd8', padding: 12 },
  errorText: { color: colors.red, fontSize: 12, fontWeight: '600' },
  sectionLabel: {
    color: colors.muted,
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 14,
  },
  passStack: { marginBottom: 18, paddingTop: 10 },
  credentialBack: {
    backgroundColor: '#2ba6b8',
    borderRadius: 16,
    height: 92,
    left: 14,
    position: 'absolute',
    right: 14,
    top: 0,
  },
  credential: {
    backgroundColor: colors.blue,
    borderRadius: 16,
    minHeight: 238,
    padding: 20,
    shadowColor: '#122859',
    shadowOffset: { height: 8, width: 0 },
    shadowOpacity: 0.2,
    shadowRadius: 18,
  },
  credentialTop: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  issuerSeal: {
    alignItems: 'center',
    backgroundColor: colors.white,
    borderRadius: 12,
    height: 40,
    justifyContent: 'center',
    width: 40,
  },
  issuerSealText: {
    color: colors.blueDark,
    fontSize: 12,
    fontWeight: '800',
  },
  status: {
    backgroundColor: '#c9f2e3',
    borderRadius: 10,
    color: '#105f51',
    fontSize: 10,
    fontWeight: '700',
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  credentialType: {
    color: colors.white,
    fontSize: 27,
    fontWeight: '700',
    letterSpacing: -0.4,
    marginTop: 28,
  },
  credentialIssuer: {
    color: '#eef3ff',
    fontSize: 12,
    marginTop: 6,
  },
  rule: { backgroundColor: '#6991ed', height: 1, marginVertical: 19 },
  credentialFooter: {
    alignItems: 'flex-end',
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  micro: {
    color: '#f3f6ff',
    fontSize: 9,
    fontWeight: '600',
  },
  person: {
    color: colors.white,
    fontSize: 16,
    fontWeight: '600',
    marginTop: 4,
  },
  detailsLabel: { color: colors.white, fontSize: 12, fontWeight: '600' },
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
    color: '#f3f6ff',
    fontSize: 9,
  },
  claimValue: {
    color: colors.white,
    fontSize: 11,
  },
  evidence: {
    color: '#f3f6ff',
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
    fontSize: 9,
    letterSpacing: 1.1,
  },
  identityCard: {
    backgroundColor: colors.white,
    borderRadius: 14,
    marginTop: 16,
    padding: 18,
  },
  identityHeading: { alignItems: 'center', flexDirection: 'row', marginBottom: 14 },
  identityAvatarSmall: {
    alignItems: 'center',
    backgroundColor: '#e6edfb',
    borderRadius: 18,
    height: 36,
    justifyContent: 'center',
    width: 36,
  },
  identityAvatarSmallText: { color: colors.blueDark, fontSize: 12, fontWeight: '700' },
  identityHeadingCopy: { flex: 1, marginLeft: 11 },
  identityTitle: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  didValue: {
    color: colors.ink,
    fontSize: 12,
    lineHeight: 17,
  },
  identityMeta: {
    color: colors.muted,
    fontSize: 11,
    marginTop: 3,
  },
  scanShortcut: {
    alignItems: 'center',
    backgroundColor: colors.blue,
    borderRadius: 14,
    flexDirection: 'row',
    justifyContent: 'center',
    minHeight: 56,
  },
  scanGlyph: {
    alignItems: 'center',
    borderColor: colors.white,
    borderRadius: 6,
    borderWidth: 2,
    height: 22,
    justifyContent: 'center',
    marginRight: 10,
    width: 22,
  },
  scanGlyphInner: { backgroundColor: colors.white, borderRadius: 2, height: 5, width: 5 },
  scanShortcutText: { color: colors.white, fontSize: 16, fontWeight: '700' },
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
    backgroundColor: colors.blue,
    borderRadius: 12,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 52,
    paddingHorizontal: 17,
    width: '100%',
  },
  primaryButtonText: {
    color: colors.white,
    fontSize: 11,
    letterSpacing: 1.2,
  },
  input: {
    backgroundColor: colors.white,
    borderColor: colors.line,
    borderRadius: 12,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 12,
    minHeight: 54,
    paddingHorizontal: 14,
  },
  inputLabel: {
    color: colors.muted,
    fontSize: 9,
    letterSpacing: 1.3,
    marginBottom: 8,
    marginTop: 18,
  },
  codeInput: { fontSize: 22, letterSpacing: 8, marginBottom: 12, textAlign: 'center' },
  or: {
    color: colors.muted,
    fontSize: 9,
    letterSpacing: 1.5,
    marginBottom: 9,
    marginTop: 20,
    textAlign: 'center',
  },
  helper: {
    color: colors.muted,
    fontSize: 10,
    lineHeight: 16,
    marginTop: 16,
  },
  cameraPlaceholder: {
    alignItems: 'center',
    backgroundColor: colors.ink,
    borderRadius: 16,
    minHeight: 235,
    padding: 28,
  },
  cameraIcon: {
    alignItems: 'center',
    borderColor: '#8db1ff',
    borderRadius: 10,
    borderWidth: 2,
    height: 46,
    justifyContent: 'center',
    width: 46,
  },
  cameraIconCore: { backgroundColor: '#8db1ff', borderRadius: 3, height: 8, width: 8 },
  cameraTitle: {
    color: colors.white,
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
    borderRadius: 16,
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
  claimCheck: { backgroundColor: colors.teal, borderRadius: 5, height: 10, width: 10 },
  claimRequestText: {
    color: colors.ink,
    fontSize: 13,
    textTransform: 'capitalize',
  },
  withheld: {
    backgroundColor: '#e9eff8',
    borderRadius: 12,
    marginBottom: 18,
    marginTop: 18,
    padding: 14,
  },
  withheldTitle: {
    color: colors.muted,
    fontSize: 9,
    letterSpacing: 1.2,
  },
  withheldText: {
    color: colors.inkSoft,
    fontSize: 11,
    lineHeight: 17,
    marginTop: 5,
  },
  denyButton: { alignItems: 'center', minHeight: 48, justifyContent: 'center' },
  denyText: {
    color: colors.red,
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
    fontSize: 8,
  },
  nav: {
    backgroundColor: colors.white,
    borderTopColor: colors.line,
    borderTopWidth: 1,
    flexDirection: 'row',
    minHeight: 70,
  },
  navButton: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    minHeight: 60,
  },
  navIcon: {
    borderColor: '#7b8798',
    borderRadius: 3,
    borderWidth: 1.8,
    height: 16,
    justifyContent: 'center',
    width: 20,
  },
  navIconScan: { borderRadius: 5, height: 19, width: 19 },
  navIconActivity: { borderRadius: 10, height: 19, width: 19 },
  navIconActive: { borderColor: colors.blue },
  walletIconLine: { backgroundColor: '#7b8798', height: 1.5, marginHorizontal: 3 },
  walletIconLineActive: { backgroundColor: colors.blue },
  scanIconCore: { alignSelf: 'center', backgroundColor: '#7b8798', height: 4, width: 4 },
  scanIconCoreActive: { backgroundColor: colors.blue },
  clockHand: { alignSelf: 'center', backgroundColor: '#7b8798', height: 6, width: 1.5 },
  clockHandActive: { backgroundColor: colors.blue },
  navLabel: {
    color: '#627087',
    fontSize: 11,
    marginTop: 5,
  },
  navActive: { color: colors.blue, fontWeight: '600' },
  pressed: { opacity: 0.75 },
  onboardingSafe: { backgroundColor: colors.paper, flex: 1 },
  onboarding: {
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 24,
  },
  onboardingBrand: { alignItems: 'center', flexDirection: 'row', gap: 8 },
  onboardingBrandName: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  onboardingTitle: {
    color: colors.ink,
    fontSize: 46,
    lineHeight: 49,
    marginTop: 16,
  },
  onboardingBody: {
    color: colors.muted,
    fontSize: 15,
    lineHeight: 23,
    marginBottom: 34,
    marginTop: 16,
  },
  inputLabelLight: {
    color: colors.muted,
    fontSize: 9,
    letterSpacing: 1.2,
    marginBottom: 8,
  },
  onboardingInput: {
    backgroundColor: colors.white,
    borderColor: colors.line,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 12,
    marginBottom: 12,
    minHeight: 54,
    paddingHorizontal: 14,
  },
  onboardingFoot: {
    color: colors.muted,
    fontSize: 9,
    lineHeight: 15,
    marginTop: 18,
    textAlign: 'center',
  },
  errorLight: {
    color: colors.red,
    fontSize: 11,
    marginBottom: 14,
  },
});
