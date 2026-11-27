import * as Clipboard from 'expo-clipboard';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Alert, Pressable, Share, Switch, Text, View } from 'react-native';

import { pairFromCode, speedTest } from '../engine';
import { lang, powershell, t } from '../i18n';
import { humanBytes, joinPath, MONTHS, parsePairing, pickShare, type Lang, type Pairing } from '../logic';
import { errorMessage, Pg, rawMessage, type FoundPc, type LoginInfo, type SpeedResult } from '../native';
import { useApp } from '../state';
import { takePendingPairing } from '../pairing';
import { prepFingerprint, usePrepServer } from '../prepServer';
import { emptySettings, newPcId } from '../store';
import { Icon, Bar, C, Card, F, Field, Header, MainButton, Screen, Segmented, Step, success, t as ty, tap } from '../ui/kit';
import { QrScanner } from '../ui/QrScanner';

/** Le fichier de préparation, joint à chaque version sur GitHub (tools/PixelGuard-PC.cmd). */
const PREP_URL = 'https://github.com/matteogalfre/PixelGuard/releases/latest/download/PixelGuard-PC.cmd';

function uncPath(host: string, share: string, folder: string) {
  const sub = folder ? '\\' + folder.replace(/\//g, '\\') : '';
  return `\\\\${host}\\${share}${sub}`;
}

// Ajouter ou modifier un PC : le trouver, se connecter, choisir le dossier partagé.
export default function PcEdit() {
  const app = useApp();
  const params = useLocalSearchParams<{ id?: string }>();
  const editing = app.pcs.find((p) => p.id === params.id) ?? null;
  const base = editing ?? emptySettings;
  const configured = !!(base.host && base.share);
  const [found, setFound] = useState<FoundPc[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState(false);
  const [host, setHost] = useState(base.host);
  const [name, setName] = useState(base.name);
  const [user, setUser] = useState(base.user);
  const [password, setPassword] = useState('');
  const [info, setInfo] = useState<LoginInfo | null>(configured ? { dialect: '', signed: false, encrypted: false, shares: [base.share], identity: base.identity ?? null } : null);
  const [share, setShare] = useState(base.share);
  const [folder, setFolder] = useState(base.folder);
  const [encrypt, setEncrypt] = useState(base.encrypt);
  const [folderLang, setFolderLang] = useState<Lang>(base.lang ?? lang);
  /** Le nom que le PC annonce, retenu à l'appairage : il sera contrôlé à chaque connexion. */
  const [identity, setIdentity] = useState(base.identity ?? '');
  const [scanOpen, setScanOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [skipPick, setSkipPick] = useState(false);
  const [os, setOs] = useState<'win' | 'mac'>('win');
  /** Un code lu par l'appareil photo du téléphone : on montre le PC et on attend « Ajouter ». */
  const [toConfirm, setToConfirm] = useState<Pairing | null>(null);

  useEffect(() => {
    const p = takePendingPairing();
    if (p) setToConfirm(p);
  }, []);
  const [busy, setBusy] = useState<'login' | 'finish' | 'speed' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(configured);
  const [savedId, setSavedId] = useState(editing?.id ?? '');
  const [copied, setCopied] = useState(false);
  const [speed, setSpeed] = useState<SpeedResult | null>(null);
  /** Chiffré ou non, connu après « C'est parti » ou le test de vitesse. */
  const [secure, setSecure] = useState<boolean | null>(null);
  const [speedBytes, setSpeedBytes] = useState(0);

  useEffect(() => {
    if (editing) app.passwordOf(editing.id).then(setPassword);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing?.id]);

  /** Le PC tel qu'il est à l'écran, prêt à être enregistré. */
  const current = () => ({
    ...emptySettings,
    id: savedId || newPcId(),
    host: host.trim(),
    name: name || host.trim(),
    share: share.trim(),
    folder: joinPath(folder.trim()),
    user: user.trim(),
    encrypt,
    lang: folderLang,
    identity,
  });

  async function scan() {
    setScanning(true);
    setError(null);
    try {
      setFound(await Pg.discover());
    } catch (e) {
      setFound([]);
      setError(errorMessage(e));
    } finally {
      setScanning(false);
    }
  }

  useEffect(() => {
    scan();
  }, []);

  function pick(pc: FoundPc) {
    tap();
    setHost(pc.ip);
    setName(pc.name);
    setInfo(null);
    setReady(false);
    setManual(false);
  }

  async function login() {
    setBusy('login');
    setError(null);
    try {
      const i = await Pg.login({ host, share: '', user, password, encrypt, identity: '' });
      setInfo(i);
      setIdentity(i.identity ?? '');
      if (i.shares?.length) setShare(pickShare(i.shares));
      if (encrypt && i.dialect && !i.encrypted) {
        // Ce PC ne sait pas chiffrer : on le dit, et le réglage suit (jamais de repli caché).
        setEncrypt(false);
        setSecure(false);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Le QR du PC préparé : tout est dedans (adresse, nom, dossier partagé, compte et mot de passe).
   * On se connecte, on vérifie que c'est bien ce PC qui répond, on teste l'écriture, c'est prêt.
   */
  async function pairWith(p: Pairing) {
    setScanOpen(false);
    setToConfirm(null);
    setHost(p.host);
    setName(p.name || p.host);
    setUser(p.user);
    setPassword(p.password);
    setShare(p.share);
    setFolder(p.folder);
    setManual(false);
    setError(null);
    setBusy('login');
    try {
      const r = await pairFromCode(p, { id: savedId || newPcId(), encrypt, lang: folderLang });
      setInfo(r.info);
      setIdentity(r.pc.identity ?? '');
      setEncrypt(r.pc.encrypt);
      setSecure(r.encrypted);
      await app.savePc(r.pc, p.password);
      setSavedId(r.pc.id);
      setReady(true);
      success();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  function onScanned(text: string) {
    setScanOpen(false);
    const p = parsePairing(text);
    if (p) pairWith(p);
    else setError(t.scanBad);
  }

  async function sendLink() {
    tap();
    await Share.share({ message: `${t.prepShareText}\n${PREP_URL}` }).catch(() => {});
  }

  async function finish() {
    setBusy('finish');
    setError(null);
    const next = current();
    try {
      const info2 = await Pg.connect({
        host: next.host, share: next.share, user: next.user, password, encrypt: next.encrypt, identity: next.identity ?? '',
      });
      setSecure(info2.encrypted);
      await Pg.testWrite(next.folder);
      await app.savePc(next, password);
      setSavedId(next.id);
      setReady(true);
      success();
    } catch (e) {
      setError(rawMessage(e).includes('ACCESS_DENIED') ? t.writeDenied(next.share) : errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function runSpeed() {
    setBusy('speed');
    setSpeed(null);
    setSpeedBytes(0);
    setError(null);
    try {
      const r = await speedTest(current(), password, setSpeedBytes);
      setSpeed(r);
      setSecure(r.encrypted);
      success();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  function forget() {
    if (!savedId) return router.back();
    Alert.alert(t.forgetTitle(name || host), t.forgetText, [
      { text: t.cancel, style: 'cancel' },
      {
        text: t.forget,
        style: 'destructive',
        onPress: async () => {
          await app.removePc(savedId);
          router.back();
        },
      },
    ]);
  }

  // Étape 1 franchie : un PC choisi, ou « il n'apparaît pas, je le prépare d'abord » (le fichier
  // de préparation règle justement le réseau « Public » qui le cache, et son code donne l'adresse).
  const step1Done = !!host || skipPick;
  const step2Done = !!info || ready;
  // L'erreur s'affiche dans l'étape en cours, pas tout en bas de l'écran.
  const where = !step1Done ? 1 : !step2Done ? 2 : !ready ? 3 : 4;
  const errorNote = error ? <ErrorNote text={error} /> : null;
  // Pendant la préparation d'un PC Windows, le téléphone propose lui-même le fichier sur le Wi-Fi.
  const prepAddress = usePrepServer(step1Done && !step2Done && os === 'win');
  // Se connecter avec son propre compte (Windows avancé, ou Mac). Sans PC choisi, on tape l'adresse.
  const loginForm = (
    <View style={{ gap: 10 }}>
      {skipPick ? (
        <Field label={t.manual} value={host} onChangeText={(v) => { setHost(v); setName(''); setInfo(null); setReady(false); }} placeholder={t.hostPh} />
      ) : null}
      <Field label={os === 'mac' ? t.userMac : t.user} value={user} onChangeText={(v) => { setUser(v); setInfo(null); setReady(false); }} placeholder={os === 'mac' ? t.userMacPh : t.userPh} />
      <Field label={os === 'mac' ? t.passwordMac : t.password} value={password} onChangeText={(v) => { setPassword(v); setInfo(null); setReady(false); }} secureTextEntry hint={os === 'mac' ? undefined : t.passwordHint} />
      <MainButton label={t.login} icon="login" kind="ghost" onPress={login} busy={busy === 'login'} disabled={!host || !user} />
    </View>
  );

  return (
    <Screen>
      <Header title={editing ? editing.name || editing.host : t.editPcTitle} subtitle={t.pcSub} />

      {toConfirm ? (
        <Card style={{ borderColor: C.accent, gap: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Icon name="qrcode" size={22} color={C.accent} />
            <Text style={[ty.h3, { flex: 1 }]}>{t.pairConfirm(toConfirm.name || toConfirm.host, toConfirm.host)}</Text>
          </View>
          <Text style={ty.small}>{t.pairConfirmText}</Text>
          <MainButton label={t.pairConfirmButton} icon="check" onPress={() => pairWith(toConfirm)} busy={busy === 'login'} />
          <Pressable onPress={() => setToConfirm(null)} accessibilityRole="button" style={{ alignSelf: 'center', padding: 8 }}>
            <Text style={[ty.small, { color: C.muted }]}>{t.cancel}</Text>
          </Pressable>
        </Card>
      ) : null}

      <Step n={1} title={t.step1} active={!step1Done} done={step1Done}>
        <View style={{ gap: 8 }}>
          {scanning ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 }}>
              <ActivityIndicator color={C.accent} />
              <Text style={ty.small}>{t.searching}</Text>
            </View>
          ) : found ? (
            <Text style={ty.small}>{found.length ? t.found(found.length) : t.nothingFound}</Text>
          ) : null}
          {(found ?? []).map((pc) => {
            const on = pc.ip === host;
            return (
              <Pressable
                key={pc.ip}
                onPress={() => pick(pc)}
                accessibilityRole="radio"
                accessibilityState={{ selected: on, checked: on }}
                accessibilityLabel={pc.name || pc.ip}
                style={({ pressed }) => ({
                  flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 16,
                  backgroundColor: on ? C.selected : pressed ? C.surfaceHi : C.inset,
                  borderWidth: 1, borderColor: on ? C.accent : C.line,
                })}
              >
                <Icon name="monitor" size={24} color={on ? C.accent : C.muted} />
                <View style={{ flex: 1 }}>
                  <Text style={ty.h3}>{pc.name || pc.ip}</Text>
                  {pc.name ? <Text style={ty.small}>{pc.ip}</Text> : null}
                </View>
                {on ? <Icon name="check-circle" size={22} color={C.accent} /> : null}
              </Pressable>
            );
          })}
          {manual ? (
            <Field label={t.manual} value={host} onChangeText={(v) => { setHost(v); setName(''); setInfo(null); setReady(false); }} placeholder={t.hostPh} />
          ) : null}
          <View style={{ flexDirection: 'row', gap: 20 }}>
            <Pressable onPress={scan} disabled={scanning} accessibilityRole="button" hitSlop={12} style={{ minHeight: 32, justifyContent: 'center' }}>
              <Text style={[ty.small, { color: C.accent, fontFamily: F.semi }]}>{t.rescan}</Text>
            </Pressable>
            {!manual ? (
              <Pressable onPress={() => setManual(true)} accessibilityRole="button" hitSlop={12} style={{ minHeight: 32, justifyContent: 'center' }}>
                <Text style={[ty.small, { color: C.accent, fontFamily: F.semi }]}>{t.manual}</Text>
              </Pressable>
            ) : null}
          </View>
          {found && !found.length ? <Help title={t.notFoundTitle} lines={t.notFoundHelp} /> : null}
          {!host ? (
            <Pressable onPress={() => { tap(); setSkipPick(true); }} accessibilityRole="button" style={{ minHeight: 44, justifyContent: 'center' }}>
              <Text style={[ty.small, { color: C.accent, fontFamily: F.semi }]}>{t.notListedPrepare}</Text>
            </Pressable>
          ) : null}
          {where === 1 ? errorNote : null}
        </View>
      </Step>

      <Step n={2} title={t.step2} active={step1Done && !step2Done} done={step2Done}>
        {step2Done ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <Text style={[ty.small, { flex: 1 }]}>{t.step2Done(user)}</Text>
            <Pressable onPress={() => { tap(); setInfo(null); setReady(false); }} accessibilityRole="button" hitSlop={10} style={{ minHeight: 32, justifyContent: 'center' }}>
              <Text style={[ty.small, { color: C.accent, fontFamily: F.semi }]}>{t.change}</Text>
            </Pressable>
          </View>
        ) : (
          <View style={{ gap: 12 }}>
            <Segmented<'win' | 'mac'>
              options={[{ value: 'win', label: 'Windows' }, { value: 'mac', label: 'Mac' }]}
              value={os}
              onChange={setOs}
            />
            {os === 'win' ? (
              <>
                <Numbered n={1} text={prepAddress ? t.prepWinLocal : t.prepWin1} />
                {prepAddress ? (
                  <View style={{ paddingLeft: 34, gap: 4 }}>
                    <Text selectable accessibilityLabel={prepAddress} style={[ty.h2, { color: C.accent, fontFamily: F.black }]}>{prepAddress}</Text>
                    <Text style={ty.hint}>{t.prepWinLocalHint}</Text>
                    <Text style={ty.hint} selectable>{t.prepPrint(prepFingerprint)}</Text>
                  </View>
                ) : null}
                <Pressable
                  onPress={sendLink}
                  accessibilityRole="button"
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 8, alignSelf: 'flex-start', minHeight: 40, paddingLeft: 34 }}
                >
                  <Icon name="share-variant" size={18} color={C.accent} />
                  <Text style={[ty.small, { color: C.accent, fontFamily: F.semi }]}>{t.prepSend}</Text>
                </Pressable>
                <Numbered n={2} text={t.prepWin2} />
                <Numbered n={3} text={t.prepWin3} />
                <MainButton label={t.scanButton} icon="qrcode-scan" onPress={() => setScanOpen(true)} busy={busy === 'login'} />
                {where === 2 ? errorNote : null}
                <Help title={t.prepAdvanced}>
                  <Text style={ty.sub}>{t.prepText}</Text>
                  <Pressable
                    onPress={async () => {
                      tap();
                      await Clipboard.setStringAsync(powershell(t.psDone, t.psUser, t.psPublic));
                      setCopied(true);
                      setTimeout(() => setCopied(false), 2000);
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={copied ? t.copied : t.copy}
                    style={{ backgroundColor: C.inset, borderRadius: 14, padding: 12, gap: 8, borderWidth: 1, borderColor: C.line }}
                  >
                    <Text style={[ty.mono, { color: C.text }]} selectable>{powershell(t.psDone, t.psUser, t.psPublic)}</Text>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-end' }}>
                      <Icon name={copied ? 'check' : 'content-copy'} size={16} color={C.accent} />
                      <Text style={[ty.small, { color: C.accent, fontFamily: F.semi }]}>{copied ? t.copied : t.copy}</Text>
                    </View>
                  </Pressable>
                  <Text style={ty.hint}>{t.prepManual}</Text>
                  {loginForm}
                </Help>
              </>
            ) : (
              <>
                {t.prepMacSteps.map((line, i) => (
                  <Numbered key={line} n={i + 1} text={line} />
                ))}
                {loginForm}
                {where === 2 ? errorNote : null}
                <Text style={ty.hint}>{t.prepMacAccount}</Text>
              </>
            )}
          </View>
        )}
      </Step>

      <Step n={3} title={t.step3} active={step2Done && !ready} done={ready}>
        {info?.shares?.length ? (
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {info.shares.map((sh) => {
              const on = sh === share;
              return (
                <Pressable
                  key={sh}
                  onPress={() => { tap(); setShare(sh); setReady(false); }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on, checked: on }}
                  style={{ minHeight: 44, paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20, borderWidth: 1, borderColor: on ? C.accent : C.line, backgroundColor: on ? C.selected : 'transparent', flexDirection: 'row', alignItems: 'center', gap: 6 }}
                >
                  <Icon name="folder-network-outline" size={16} color={on ? C.accent : C.muted} />
                  <Text style={{ color: on ? C.accent : C.text, fontFamily: F.semi }}>{sh}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : (
          <Field label={t.shareManual} value={share} onChangeText={(v) => { setShare(v); setReady(false); }} placeholder={t.sharePh} />
        )}
        <Field label={t.folder} value={folder} onChangeText={(v) => { setFolder(v); setReady(false); }} placeholder={t.folderPh} />
        {where === 3 ? errorNote : null}
        {!ready ? <MainButton label={t.finish} icon="check" onPress={finish} busy={busy === 'finish'} disabled={!share} /> : null}
        {ready ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Icon name="check-decagram" size={20} color={C.ok} />
            <Text style={[ty.h3, { color: C.ok }]}>{t.ready}</Text>
            <Text style={[ty.small, { flex: 1 }]} numberOfLines={1}>{uncPath(name || host, share, folder)}</Text>
          </View>
        ) : null}
        {ready && secure != null ? (
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
            <Icon name={secure ? 'lock' : 'lock-open-alert'} size={18} color={secure ? C.ok : C.warn} />
            <Text style={[ty.small, { flex: 1, color: secure ? C.ok : C.warn }]}>{secure ? t.encrypted : t.notEncrypted}</Text>
          </View>
        ) : null}
      </Step>

      {ready && !editing ? (
        // Fin de l'appairage : direction l'accueil, qui compare tout seul avec le PC.
        <MainButton label={t.goBackup} icon="cloud-upload" onPress={() => router.dismissTo('/')} />
      ) : null}

      {where === 4 ? errorNote : null}

      {ready ? (
        // Réglages qu'on ne touche presque jamais : repliés, pour que l'écran reste simple.
        <Card onPress={() => setShowAdvanced(!showAdvanced)} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Icon name="tune-variant" size={22} color={C.accent} />
          <Text style={[ty.h3, { flex: 1 }]}>{t.advanced}</Text>
          <Icon name={showAdvanced ? 'chevron-up' : 'chevron-down'} size={22} color={C.muted} />
        </Card>
      ) : null}

      {ready && showAdvanced ? (
        <>

          <Card style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Icon name={encrypt ? 'lock' : 'lock-open-variant-outline'} size={22} color={encrypt ? C.ok : C.warn} />
              <Text style={[ty.h3, { flex: 1 }]}>{t.encryptTitle}</Text>
              <Switch
                value={encrypt}
                onValueChange={async (v) => {
                  tap();
                  setEncrypt(v);
                  setSecure(null);
                  setSpeed(null);
                  if (savedId) await app.savePc({ ...current(), encrypt: v }, password);
                }}
                trackColor={{ true: C.accent, false: C.line }}
                thumbColor="#fff"
              />
            </View>
            <Text style={ty.small}>{t.encryptHint}</Text>
          </Card>

          <Card style={{ gap: 8 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
              <Icon name="folder-text-outline" size={22} color={C.accent} />
              <Text style={[ty.h3, { flex: 1 }]}>{t.folderLangTitle}</Text>
            </View>
            <Segmented
              options={(['fr', 'en'] as Lang[]).map((l) => ({ value: l, label: `${new Date().getFullYear()} ${MONTHS[l][new Date().getMonth()]}` }))}
              value={folderLang}
              onChange={async (v) => {
                tap();
                setFolderLang(v);
                if (savedId) await app.savePc({ ...current(), lang: v }, password);
              }}
            />
            <Text style={ty.small}>{t.folderLangHint}</Text>
          </Card>

          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
              <Icon name="speedometer" size={22} color={C.accent2} />
              <Text style={[ty.h3, { flex: 1 }]}>{t.speedTitle}</Text>
            </View>
            <Text style={ty.small}>{t.speedText}</Text>
            {busy === 'speed' ? <Bar value={speedBytes / (128 * 1048576)} /> : null}
            {speed ? (
              <View style={{ gap: 2 }}>
                <Text style={ty.big} maxFontSizeMultiplier={1.3}>{t.speedResult(humanBytes(speed.bytes / speed.seconds, lang))}</Text>
                <Text style={ty.small}>
                  {t.speedDetails(speed.dialect.replace('SMB_', 'SMB ').replace(/_/g, '.'), speed.encrypted, speed.signed, speed.signingCrypto)}
                </Text>
              </View>
            ) : null}
            <MainButton label={t.speedRun} kind="ghost" icon="play" onPress={runSpeed} busy={busy === 'speed'} />
          </Card>
        </>
      ) : null}

      <QrScanner visible={scanOpen} onCode={onScanned} onClose={() => setScanOpen(false)} />

      {savedId ? (
        <Pressable onPress={forget} accessibilityRole="button" hitSlop={8} style={{ alignSelf: 'center', padding: 12 }}>
          <Text style={[ty.small, { color: C.danger }]}>{t.forget}</Text>
        </Pressable>
      ) : null}
    </Screen>
  );
}

function ErrorNote({ text }: { text: string }) {
  return (
    <View
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      style={{ flexDirection: 'row', gap: 10, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: C.dangerLine, backgroundColor: C.dangerBg }}
    >
      <Icon name="alert-circle-outline" size={20} color={C.danger} />
      <Text style={[ty.body, { flex: 1, color: C.text }]}>{text}</Text>
    </View>
  );
}

/** Une étape numérotée d'un mode d'emploi. */
function Numbered({ n, text }: { n: number; text: string }) {
  return (
    <View style={{ flexDirection: 'row', gap: 10 }}>
      <View style={{ width: 24, height: 24, borderRadius: 12, borderWidth: 1.5, borderColor: C.accent, alignItems: 'center', justifyContent: 'center' }}>
        <Text style={{ color: C.accent, fontFamily: F.bold, fontSize: 12 }}>{n}</Text>
      </View>
      <Text style={[ty.body, { flex: 1 }]}>{text}</Text>
    </View>
  );
}

/** Une aide repliée : le titre, puis les explications au toucher. */
function Help({ title, lines, children }: { title: string; lines?: string[]; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 8 }}>
      <Pressable
        onPress={() => {
          tap();
          setOpen(!open);
        }}
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        style={{ flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 40 }}
      >
        <Icon name="help-circle-outline" size={18} color={C.accent} />
        <Text style={[ty.small, { flex: 1, color: C.accent, fontFamily: F.semi }]}>{title}</Text>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} size={20} color={C.muted} />
      </Pressable>
      {open ? (lines ?? []).map((l) => <Text key={l} style={ty.body}>{l}</Text>) : null}
      {open ? children : null}
    </View>
  );
}

