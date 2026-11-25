import { MaterialCommunityIcons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, Switch, Text, View } from 'react-native';

import { speedTest } from '../engine';
import { lang, POWERSHELL, t } from '../i18n';
import { humanBytes, joinPath, pickShare } from '../logic';
import { errorMessage, Pg, type FoundPc, type LoginInfo, type SpeedResult } from '../native';
import { useApp } from '../state';
import { emptySettings } from '../store';
import { Bar, C, Card, F, Field, Header, MainButton, Screen, Step, success, t as ty, tap } from '../ui/kit';

function uncPath(host: string, share: string, folder: string) {
  const sub = folder ? '\\' + folder.replace(/\//g, '\\') : '';
  return `\\\\${host}\\${share}${sub}`;
}

export default function PcScreen() {
  const app = useApp();
  const configured = !!(app.pc.host && app.pc.share);
  const [found, setFound] = useState<FoundPc[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [manual, setManual] = useState(false);
  const [host, setHost] = useState(app.pc.host);
  const [name, setName] = useState(app.pc.name);
  const [user, setUser] = useState(app.pc.user);
  const [password, setPassword] = useState(app.password);
  const [info, setInfo] = useState<LoginInfo | null>(configured ? { dialect: '', signed: false, encrypted: false, shares: [app.pc.share] } : null);
  const [share, setShare] = useState(app.pc.share);
  const [folder, setFolder] = useState(app.pc.folder);
  const [encrypt, setEncrypt] = useState(app.pc.encrypt);
  const [busy, setBusy] = useState<'login' | 'finish' | 'speed' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(configured);
  const [copied, setCopied] = useState(false);
  const [showPrep, setShowPrep] = useState(!configured);
  const [speed, setSpeed] = useState<SpeedResult | null>(null);
  /** Chiffré ou non, connu après « C'est parti » ou le test de vitesse. */
  const [secure, setSecure] = useState<boolean | null>(null);
  const [speedBytes, setSpeedBytes] = useState(0);

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
      const i = await Pg.login({ host, share: '', user, password, encrypt });
      setInfo(i);
      if (i.shares?.length) setShare(pickShare(i.shares));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function finish() {
    setBusy('finish');
    setError(null);
    const next = { ...emptySettings, host: host.trim(), name: name || host.trim(), share: share.trim(), folder: joinPath(folder.trim()), user: user.trim(), encrypt };
    try {
      const info2 = await Pg.connect({ host: next.host, share: next.share, user: next.user, password, encrypt });
      setSecure(info2.encrypted);
      await Pg.testWrite(next.folder);
      await app.savePc(next, password);
      setReady(true);
      success();
    } catch (e) {
      const msg = errorMessage(e);
      setError(msg.includes('ACCESS_DENIED') ? t.writeDenied(next.share) : msg);
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
      const r = await speedTest(app.pc, app.password, setSpeedBytes);
      setSpeed(r);
      setSecure(r.encrypted);
      success();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function forget() {
    await app.savePc(emptySettings, '');
    setHost('');
    setName('');
    setUser('');
    setPassword('');
    setInfo(null);
    setShare('');
    setFolder('');
    setReady(false);
    setSpeed(null);
    setEncrypt(true);
  }

  const step1Done = !!host;
  const step2Done = !!info;

  return (
    <Screen>
      <Header title={t.pcTitle} subtitle={t.pcSub} />

      <Card onPress={() => setShowPrep(!showPrep)}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <MaterialCommunityIcons name="microsoft-windows" size={20} color={C.cyan} />
          <Text style={[ty.h3, { flex: 1 }]}>{t.prepTitle}</Text>
          <MaterialCommunityIcons name={showPrep ? 'chevron-up' : 'chevron-down'} size={22} color={C.muted} />
        </View>
        {showPrep ? (
          <View style={{ gap: 10 }}>
            <Text style={ty.sub}>{t.prepText}</Text>
            <Pressable
              onPress={async () => {
                tap();
                await Clipboard.setStringAsync(POWERSHELL);
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }}
              style={{ backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 14, padding: 12, gap: 8, borderWidth: 1, borderColor: C.line }}
            >
              <Text style={[ty.mono, { color: C.text }]} selectable>{POWERSHELL}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-end' }}>
                <MaterialCommunityIcons name={copied ? 'check' : 'content-copy'} size={16} color={C.cyan} />
                <Text style={[ty.small, { color: C.cyan, fontFamily: F.semi }]}>{copied ? t.copied : t.copy}</Text>
              </View>
            </Pressable>
            <Text style={ty.hint}>{t.prepManual}</Text>
          </View>
        ) : null}
      </Card>

      <Step n={1} title={t.step1} active={!step1Done} done={step1Done}>
        <View style={{ gap: 8 }}>
          {scanning ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 }}>
              <ActivityIndicator color={C.cyan} />
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
                style={({ pressed }) => ({
                  flexDirection: 'row', alignItems: 'center', gap: 12, padding: 12, borderRadius: 16,
                  backgroundColor: on ? 'rgba(34,195,240,0.12)' : pressed ? C.surfaceHi : 'rgba(0,0,0,0.25)',
                  borderWidth: 1, borderColor: on ? C.cyan : C.line,
                })}
              >
                <MaterialCommunityIcons name="monitor" size={24} color={on ? C.cyan : C.muted} />
                <View style={{ flex: 1 }}>
                  <Text style={ty.h3}>{pc.name || pc.ip}</Text>
                  {pc.name ? <Text style={ty.small}>{pc.ip}</Text> : null}
                </View>
                {on ? <MaterialCommunityIcons name="check-circle" size={22} color={C.cyan} /> : null}
              </Pressable>
            );
          })}
          {manual ? (
            <Field label={t.manual} value={host} onChangeText={(v) => { setHost(v); setName(''); setInfo(null); setReady(false); }} placeholder={t.hostPh} />
          ) : null}
          <View style={{ flexDirection: 'row', gap: 16 }}>
            <Pressable onPress={scan} disabled={scanning}>
              <Text style={[ty.small, { color: C.cyan, fontFamily: F.semi }]}>{t.rescan}</Text>
            </Pressable>
            {!manual ? (
              <Pressable onPress={() => setManual(true)}>
                <Text style={[ty.small, { color: C.cyan, fontFamily: F.semi }]}>{t.manual}</Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      </Step>

      <Step n={2} title={t.step2} active={step1Done && !step2Done} done={step2Done}>
        <Field label={t.user} value={user} onChangeText={(v) => { setUser(v); setInfo(null); setReady(false); }} placeholder={t.userPh} />
        <Field label={t.password} value={password} onChangeText={(v) => { setPassword(v); setInfo(null); setReady(false); }} secureTextEntry hint={t.passwordHint} />
        {!step2Done ? <MainButton label={t.login} icon="login" onPress={login} busy={busy === 'login'} disabled={!host || !user} /> : null}
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
                  style={{ paddingHorizontal: 14, paddingVertical: 9, borderRadius: 20, borderWidth: 1, borderColor: on ? C.cyan : C.line, backgroundColor: on ? 'rgba(34,195,240,0.12)' : 'transparent', flexDirection: 'row', alignItems: 'center', gap: 6 }}
                >
                  <MaterialCommunityIcons name="folder-network-outline" size={16} color={on ? C.cyan : C.muted} />
                  <Text style={{ color: on ? C.cyan : C.text, fontFamily: F.semi }}>{sh}</Text>
                </Pressable>
              );
            })}
          </View>
        ) : (
          <Field label={t.shareManual} value={share} onChangeText={(v) => { setShare(v); setReady(false); }} placeholder={t.sharePh} />
        )}
        <Field label={t.folder} value={folder} onChangeText={(v) => { setFolder(v); setReady(false); }} placeholder={t.folderPh} />
        {!ready ? <MainButton label={t.finish} icon="check" onPress={finish} busy={busy === 'finish'} disabled={!share} /> : null}
        {ready ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <MaterialCommunityIcons name="check-decagram" size={20} color={C.ok} />
            <Text style={[ty.h3, { color: C.ok }]}>{t.ready}</Text>
            <Text style={[ty.small, { flex: 1 }]} numberOfLines={1}>{uncPath(name || host, share, folder)}</Text>
          </View>
        ) : null}
        {ready && secure != null ? (
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
            <MaterialCommunityIcons name={secure ? 'lock' : 'lock-open-alert'} size={18} color={secure ? C.ok : C.warn} />
            <Text style={[ty.small, { flex: 1, color: secure ? C.ok : C.warn }]}>{secure ? t.encrypted : t.notEncrypted}</Text>
          </View>
        ) : null}
      </Step>

      {error ? <Text style={[ty.body, { color: C.danger }]}>{error}</Text> : null}

      {ready ? (
        <Card style={{ gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <MaterialCommunityIcons name={encrypt ? 'lock' : 'lock-open-variant-outline'} size={22} color={encrypt ? C.ok : C.warn} />
            <Text style={[ty.h3, { flex: 1 }]}>{t.encryptTitle}</Text>
            <Switch
              value={encrypt}
              onValueChange={async (v) => {
                tap();
                setEncrypt(v);
                setSecure(null);
                setSpeed(null);
                await app.savePc({ ...app.pc, encrypt: v }, app.password);
              }}
              trackColor={{ true: C.cyan, false: C.line }}
              thumbColor="#fff"
            />
          </View>
          <Text style={ty.small}>{t.encryptHint}</Text>
        </Card>
      ) : null}

      {ready ? (
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            <MaterialCommunityIcons name="speedometer" size={22} color={C.violet} />
            <Text style={[ty.h3, { flex: 1 }]}>{t.speedTitle}</Text>
          </View>
          <Text style={ty.small}>{t.speedText}</Text>
          {busy === 'speed' ? <Bar value={speedBytes / (128 * 1048576)} /> : null}
          {speed ? (
            <View style={{ gap: 2 }}>
              <Text style={ty.big}>{t.speedResult(humanBytes(speed.bytes / speed.seconds, lang))}</Text>
              <Text style={ty.small}>
                {t.speedDetails(speed.dialect.replace('SMB_', 'SMB ').replace(/_/g, '.'), speed.encrypted, speed.signed, speed.signingCrypto)}
              </Text>
            </View>
          ) : null}
          <MainButton label={t.speedRun} kind="ghost" icon="play" onPress={runSpeed} busy={busy === 'speed'} />
        </Card>
      ) : null}

      {configured ? (
        <Pressable onPress={forget} style={{ alignSelf: 'center', padding: 8 }}>
          <Text style={[ty.small, { color: C.danger }]}>{t.forget}</Text>
        </Pressable>
      ) : null}
    </Screen>
  );
}
