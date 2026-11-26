import { MaterialCommunityIcons } from '@expo/vector-icons';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import * as Network from 'expo-network';
import { Redirect, router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Platform, Pressable, Text, View } from 'react-native';

import { preview, runBackup, stop, type BackupResult, type Progress } from '../engine';
import { ago, lang, periodLabel, t } from '../i18n';
import { folderFor, humanBytes, humanDuration, joinPath, typicalRate } from '../logic';
import { errorCode, errorMessage, isDemo, Pg } from '../native';
import { useApp } from '../state';
import { Logo } from '../ui/Logo';
import { Bar, C, Card, DoneCheck, Dot, F, Icon, IconButton, MainButton, Ring, Screen, Segmented, Sparkline, success, t as ty, tap, Thumb } from '../ui/kit';

/** Libère l'écran allumé, sans planter s'il n'avait pas pu être activé. */
function releaseAwake(tag: string) {
  try {
    Promise.resolve(deactivateKeepAwake(tag)).catch(() => {});
  } catch {
    // rien à libérer
  }
}

const size = (n: number) => humanBytes(n, lang);
const KEEP_AWAKE = 'pixelguard-run';

async function onWifi(): Promise<boolean> {
  if (isDemo) return true;
  const st = await Network.getNetworkStateAsync();
  return st.type === Network.NetworkStateType.WIFI;
}

export default function Home() {
  const app = useApp();
  const { pc, albums, selected, stats, preview: cmp, excluded } = app;
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<BackupResult | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const [speeds, setSpeeds] = useState<number[]>([]);
  const [graphWidth, setGraphWidth] = useState(0);
  const [cmpState, setCmpState] = useState<'idle' | 'running' | 'error'>('idle');
  const [cmpError, setCmpError] = useState('');
  const running = progress != null;
  const lastSample = useRef(0);
  const cmpRun = useRef(0);
  const configured = !!(pc.host && pc.share);

  // Le PC répond-il ? Un simple essai de connexion au port SMB, à chaque retour sur l'écran.
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      if (pc.host) {
        setOnline(null);
        Pg.probe(pc.host).then((ok) => alive && setOnline(ok));
      } else {
        setOnline(null);
      }
      app.refresh();
      return () => {
        alive = false;
      };
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [pc.host, pc.id]),
  );

  // Ce qu'on compare : si ça change pendant une comparaison, son résultat ne vaut plus rien.
  const selectionKey = JSON.stringify([selected, app.kinds, app.period, app.sorting, pc.id, pc.lang]);

  // Dès que le PC répond, on compare : « X déjà là, il manque celles-là ». Relancé quand la
  // sélection change (albums, type, période, rangement, PC), sans rien envoyer.
  useEffect(() => {
    if (!configured || online !== true || running || !app.ready || cmp) return;
    const run = ++cmpRun.current;
    setCmpState('running');
    const timer = setTimeout(async () => {
      try {
        const r = await preview({
          pc, password: app.password, albumIds: selected, kinds: app.kinds, period: app.period, sorting: app.sorting, lang,
        });
        if (run !== cmpRun.current) return;
        app.setPreview(r);
        setCmpState('idle');
        app.refresh();
      } catch (e) {
        if (run !== cmpRun.current) return;
        setCmpError(errorMessage(e));
        setCmpState('error');
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      cmpRun.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [online, configured, app.ready, running, cmp, selectionKey]);

  useEffect(() => {
    if (!progress || progress.phase !== 'send') return;
    const now = Date.now();
    if (now - lastSample.current < 500) return;
    lastSample.current = now;
    setSpeeds((v) => [...v.slice(-59), progress.speed]);
  }, [progress]);

  if (!app.ready) return <Screen>{null}</Screen>;

  // Premier lancement : trois écrans (photos, PC, albums) au lieu de tout l'accueil d'un coup.
  if (!app.welcomeDone && app.pcs.length === 0) return <Redirect href="/welcome" />;

  if (app.access === 'none' || app.access === 'blocked' || app.access === 'unknown') {
    const blocked = app.access === 'blocked';
    return (
      <Screen>
        <View style={{ height: 80 }} />
        <Logo size={64} />
        <Text style={ty.h1} accessibilityRole="header">{t.permTitle}</Text>
        <Text style={ty.sub}>{t.permText}</Text>
        {blocked ? <Text style={[ty.body, { color: C.warn }]}>{t.permBlocked}</Text> : null}
        <MainButton
          label={blocked ? t.permSettings : t.permButton}
          icon={blocked ? 'cog-outline' : 'image-multiple'}
          onPress={app.requestAccess}
        />
      </Screen>
    );
  }

  const chosen = albums.filter((a) => selected.includes(a.id));
  const toSend = cmp ? cmp.missing.filter((m) => !excluded.has(m.id)) : [];
  const toSendBytes = toSend.reduce((n, m) => n + m.size, 0);
  const lastRun = app.history[0];
  const isCustom = !['all', 'thisMonth', 'lastMonth'].includes(app.period.kind);

  async function backup() {
    if (!configured) return router.push('/pc');
    if (!(await onWifi())) return Alert.alert('Wi-Fi', t.wifiOnly);
    setResult(null);
    setSpeeds([]);
    await activateKeepAwakeAsync(KEEP_AWAKE).catch(() => {});
    try {
      const r = await runBackup({
        pc, password: app.password, albumIds: selected, kinds: app.kinds, period: app.period, sorting: app.sorting, lang,
        exclude: excluded, onProgress: setProgress,
      });
      setResult(r);
      // Rien à envoyer, rien d'échoué : pas de ligne vide dans l'historique.
      if (r.uploaded || r.failed || r.cancelled) await app.addToHistory({
        at: Date.now(), pcName: pc.name || pc.host, uploaded: r.uploaded, skipped: r.skipped, failed: r.failed,
        bytes: r.bytes, seconds: r.seconds, cancelled: r.cancelled, encrypted: r.encrypted,
      });
      if (!r.failed && !r.cancelled) success();
    } catch (e) {
      // Arrêté avant le premier envoi (pendant la comparaison) : rien à signaler.
      if (errorCode(e) !== 'CANCELLED') Alert.alert('PixelGuard', errorMessage(e));
    } finally {
      releaseAwake(KEEP_AWAKE);
      setProgress(null);
      app.setPreview(null); // on recompare : ce qui vient de partir est maintenant sur le PC
      app.refresh();
    }
  }

  // ---------------------------------------------------------------- en cours

  if (running && progress) {
    const ratio = progress.totalBytes ? progress.doneBytes / progress.totalBytes : 0;
    const sending = progress.phase === 'send';
    return (
      <Screen>
        <View style={{ height: 8 }} />
        <Text style={ty.label}>{t.phase[progress.phase]}</Text>
        <View style={{ alignItems: 'center', marginVertical: 8 }}>
          <Ring value={sending ? ratio : 0} size={230} stroke={16} label={sending ? `${Math.floor(ratio * 100)} %, ${t.files(progress.doneFiles, progress.totalFiles)}` : t.phase[progress.phase]}>
            {sending ? (
              <>
                <Text style={ty.big} maxFontSizeMultiplier={1.3}>{Math.floor(ratio * 100)} %</Text>
                <Text style={ty.small} maxFontSizeMultiplier={1.3}>{t.files(progress.doneFiles, progress.totalFiles)}</Text>
              </>
            ) : (
              <Text style={[ty.small, { textAlign: 'center', paddingHorizontal: 30 }]}>{progress.detail ?? '…'}</Text>
            )}
          </Ring>
        </View>

        {sending ? (
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'flex-end', justifyContent: 'space-between' }}>
              <View>
                <Text style={[ty.h2, { fontFamily: F.black }]}>
                  {size(progress.speed)}
                  <Text style={ty.small}>{t.perSecond}</Text>
                </Text>
                <Text style={ty.small}>
                  {size(progress.doneBytes)} / {size(progress.totalBytes)}
                </Text>
              </View>
              <Text style={ty.small}>{t.left(humanDuration(progress.eta))}</Text>
            </View>
            <View onLayout={(e) => setGraphWidth(e.nativeEvent.layout.width)}>
              <Sparkline values={speeds} width={graphWidth} />
            </View>
          </Card>
        ) : null}

        {progress.live.map((f) => (
          <View key={f.id} style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Thumb uri={f.uri} size={52} />
            <View style={{ flex: 1, gap: 6 }}>
              <Text style={ty.mono} numberOfLines={1}>{f.name}</Text>
              <Bar value={f.size ? f.bytes / f.size : 0} height={4} />
            </View>
          </View>
        ))}

        {Platform.OS === 'ios' ? <Text style={[ty.small, { textAlign: 'center' }]}>{t.keepOpen}</Text> : null}
        <MainButton label={t.stop} kind="ghost" icon="stop-circle-outline" onPress={stop} />
      </Screen>
    );
  }

  // ---------------------------------------------------------------- au repos

  // L'anneau ne montre que ce qu'on sait vraiment : la comparaison avec le PC, sinon ce que
  // la dernière comparaison a vu (et on le dit), sinon rien.
  let ratio = 0;
  let center = '?';
  let caption = t.notCompared;
  let status = '';
  let statusColor: string = C.text;
  if (cmp) {
    if (cmp.total === 0) {
      center = '0';
      caption = t.onPc;
      status = t.noFiles;
      statusColor = C.muted;
    } else {
      ratio = cmp.already / cmp.total;
      center = `${Math.floor(ratio * 100)} %`;
      caption = t.onPc;
      if (cmp.missing.length === 0) {
        status = t.allOnPc;
        statusColor = C.ok;
      } else status = t.toSend(toSend.length, size(toSendBytes));
    }
  } else if (stats && stats.saved > 0 && stats.total > 0) {
    ratio = stats.saved / stats.total;
    center = `${Math.floor(ratio * 100)} %`;
    caption = t.knownOnly;
    status = online === false ? t.offlineStatus : t.comparing;
  } else if (configured) {
    status = online === false ? t.offlineStatus : t.comparing;
    statusColor = C.muted;
  }

  // Une grosse sauvegarde (la première sur « Tout », souvent) : combien de temps, à peu près.
  const measuredRate = typicalRate(app.history);
  const etaSeconds = cmp && toSend.length ? toSendBytes / (measuredRate ?? 25e6) : 0;

  const sample = stats?.samples[0] ?? { name: '20261125_093012.jpg', taken: 0, modified: 0, bucketName: 'Camera', video: false };
  const sortingExample = joinPath(pc.share || 'PixelGuard', pc.folder, folderFor(sample, app.sorting, pc.lang ?? lang), sample.name).replace(/\//g, ' › ');

  return (
    <Screen>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Logo size={30} />
          <Text style={[ty.h2, { fontFamily: F.black }]}>PixelGuard</Text>
        </View>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <IconButton icon="history" label={t.historyTitle} onPress={() => router.push('/history')} />
          <IconButton icon="cog-outline" label={t.pcRow} onPress={() => router.push('/pc')} />
        </View>
      </View>
      {isDemo ? <Text style={[ty.small, { color: C.warn }]}>{t.demo}</Text> : null}
      {app.access === 'limited' ? (
        <Card style={{ borderColor: C.warnLine, gap: 8 }}>
          <Alert2 icon="image-lock-outline" color={C.warn} text={t.permLimited} />
          <Pressable onPress={app.moreAccess} accessibilityRole="button" hitSlop={10} style={{ alignSelf: 'flex-start', minHeight: 32, justifyContent: 'center' }}>
            <Text style={[ty.small, { color: C.accent, fontFamily: F.semi }]}>{t.permWiden}</Text>
          </Pressable>
        </Card>
      ) : null}

      <View style={{ alignItems: 'center', marginTop: 8 }}>
        <Ring value={ratio} size={230} stroke={16} label={`${center}, ${caption}`}>
          <Text style={ty.big} maxFontSizeMultiplier={1.3}>{center}</Text>
          {/* Reste dans le cercle : une légende longue passe sur deux lignes au lieu de mordre sur l'anneau. */}
          <Text numberOfLines={2} maxFontSizeMultiplier={1.3} style={[ty.small, { textAlign: 'center', maxWidth: 160 }]}>{caption}</Text>
        </Ring>
        {status ? (
          <Text accessibilityLiveRegion="polite" style={[ty.h3, { marginTop: 14, color: statusColor, textAlign: 'center' }]}>{status}</Text>
        ) : null}
        {etaSeconds > 120 ? (
          <Text style={[ty.small, { textAlign: 'center', marginTop: 2 }]}>{t.estimate(humanDuration(etaSeconds), measuredRate != null)}</Text>
        ) : null}
        {etaSeconds > 1800 ? <Text style={[ty.hint, { textAlign: 'center', marginTop: 2, paddingHorizontal: 12 }]}>{t.longTip}</Text> : null}
        {lastRun ? (
          <Pressable onPress={() => router.push('/history')} accessibilityRole="button" hitSlop={12}>
            <Text style={[ty.small, { marginTop: 2 }]}>{t.lastRun(ago(lastRun.at))}</Text>
          </Pressable>
        ) : null}
      </View>

      {result && !result.failed && !result.cancelled ? (
        <DoneCheck
          title={t.allSafe}
          detail={`${t.result(result.uploaded, result.skipped, result.failed)} · ${humanDuration(result.seconds)}`}
        />
      ) : result ? (
        <Card style={{ borderColor: result.failed ? C.warn : C.okLine }}>
          <Text style={[ty.h3, { color: result.failed ? C.warn : C.ok }]}>{t.result(result.uploaded, result.skipped, result.failed)}</Text>
          <Text style={ty.small}>{t.resultTime(size(result.bytes), humanDuration(result.seconds))}</Text>
          {result.cancelled ? <Text style={[ty.small, { color: C.warn }]}>{t.stopped}</Text> : null}
          {result.errors.slice(0, 5).map((e) => (
            <Text key={e} style={ty.hint}>{e}</Text>
          ))}
        </Card>
      ) : null}

      <View style={{ flexDirection: 'row', gap: 12 }}>
        <Card style={{ flex: 1 }} onPress={() => router.push('/pc')}>
          <Icon name="monitor" size={22} color={C.accent} />
          <Text style={ty.h3} numberOfLines={1}>{configured ? pc.name || pc.host : t.noPc}</Text>
          {configured ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Dot color={online == null ? C.faint : online ? C.ok : C.danger} />
              <Text style={ty.small} numberOfLines={1}>
                {online == null ? '…' : online ? t.online : t.offline} · {pc.share}
              </Text>
            </View>
          ) : null}
        </Card>
        <Card style={{ flex: 1 }} onPress={() => router.push('/albums')}>
          <View style={{ flexDirection: 'row', height: 22 }}>
            {chosen.slice(0, 4).map((a, i) => (
              <Thumb key={a.id} uri={a.cover} size={22} radius={11} style={{ marginLeft: i ? -6 : 0, borderWidth: 1.5, borderColor: C.bg }} />
            ))}
            {chosen.length === 0 ? <Icon name="image-multiple-outline" size={22} color={C.accent} /> : null}
          </View>
          <Text style={ty.h3}>{t.sources}</Text>
          <Text style={ty.small} numberOfLines={1}>
            {chosen.length ? `${t.albumsCount(chosen.length)} · ${t.kinds[app.kinds]}` : t.noAlbum}
          </Text>
        </Card>
      </View>

      <Card onPress={() => router.push('/sorting')} style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <Icon name="file-tree-outline" size={24} color={C.accent} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={ty.h3}>{t.sortingRow}</Text>
          <Text style={ty.mono} numberOfLines={1}>{sortingExample}</Text>
        </View>
        <Icon name="chevron-right" size={22} color={C.muted} />
      </Card>

      <Segmented<string>
        options={[
          ...(['all', 'thisMonth', 'lastMonth'] as const).map((k) => ({ value: k, label: t.periods[k] })),
          { value: 'custom', label: isCustom ? periodLabel(app.period) : t.custom },
        ]}
        value={isCustom ? 'custom' : app.period.kind}
        onChange={(k) => {
          if (k === 'all' || k === 'thisMonth' || k === 'lastMonth') app.setPeriod({ kind: k });
          else router.push('/period');
        }}
      />

      <MainButton
        label={!configured ? t.noPc : cmp ? (toSend.length ? t.backupN(toSend.length) : t.checkAgain) : t.backup}
        icon={!configured ? 'monitor' : 'cloud-upload'}
        onPress={configured && cmp && cmp.missing.length === 0 ? () => app.setPreview(null) : backup}
        disabled={configured && (chosen.length === 0 || (!!cmp && cmp.missing.length > 0 && toSend.length === 0))}
      />

      {configured ? (
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={ty.label}>{t.cmpTitle}</Text>
            {cmpState === 'running' ? <ActivityIndicator size="small" color={C.accent} /> : null}
            {cmp && cmp.missing.length ? (
              <Pressable onPress={() => { tap(); router.push('/review'); }} accessibilityRole="button" hitSlop={14}>
                <Text style={[ty.small, { color: C.accent, fontFamily: F.semi }]}>{t.choose}</Text>
              </Pressable>
            ) : null}
          </View>
          {online === false ? <Text style={ty.small}>{t.cmpOffline}</Text> : null}
          {cmpState === 'error' ? <Text style={[ty.small, { color: C.danger }]}>{t.cmpFailed(cmpError)}</Text> : null}
          {cmp && online !== false ? (
            <View style={{ gap: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Icon name="check-circle" size={18} color={C.ok} />
                <Text style={ty.body}>{t.cmpAlready(cmp.already, size(cmp.alreadyBytes))}</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <Icon name={cmp.missing.length ? 'arrow-up-circle' : 'check-all'} size={18} color={cmp.missing.length ? C.accent : C.ok} />
                <Text style={ty.body}>
                  {cmp.missing.length ? t.cmpMissing(cmp.missing.length, size(cmp.missingBytes)) : t.cmpNothingMissing}
                </Text>
              </View>
              {cmp.missing.length ? (
                <Pressable
                  onPress={() => router.push('/review')}
                  accessibilityRole="button"
                  accessibilityLabel={t.choose}
                  style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}
                >
                  {cmp.missing.slice(0, 7).map((m) => (
                    <Thumb key={m.id} uri={m.uri} size={40} radius={10} style={excluded.has(m.id) ? { opacity: 0.25 } : undefined} />
                  ))}
                  {cmp.missing.length > 7 ? (
                    <View style={{ width: 40, height: 40, borderRadius: 10, backgroundColor: C.surfaceHi, alignItems: 'center', justifyContent: 'center' }}>
                      <Text style={[ty.small, { color: C.text }]}>{t.more(cmp.missing.length - 7)}</Text>
                    </View>
                  ) : null}
                </Pressable>
              ) : null}
              {excluded.size ? <Alert2 icon="minus-circle-outline" color={C.muted} text={t.excludedNote(excluded.size)} /> : null}
              {cmp.renamed > 0 ? <Alert2 icon="alert" color={C.warn} text={t.cmpRenamed(cmp.renamed)} /> : null}
              {cmp.extraOnPc > 0 ? <Alert2 icon="information" color={C.muted} text={t.cmpExtra(cmp.extraOnPc)} /> : null}
              {!cmp.encrypted ? <Alert2 icon="lock-open-alert" color={C.warn} text={t.cmpNotEncrypted} /> : null}
            </View>
          ) : null}
        </Card>
      ) : null}

      {stats && stats.saved > 0 ? (
        <Card onPress={() => router.push('/free')} style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
          <Icon name="broom" size={24} color={C.accent2} />
          <View style={{ flex: 1 }}>
            <Text style={ty.h3}>{t.freeRow}</Text>
            <Text style={ty.small}>{t.freeRowSub(size(stats.savedBytes))}</Text>
          </View>
          <Icon name="chevron-right" size={22} color={C.muted} />
        </Card>
      ) : null}

      {/* Toujours atteignable, même avant d'avoir ajouté un PC. */}
      <Pressable onPress={() => router.push('/about')} accessibilityRole="button" hitSlop={10} style={{ alignSelf: 'center', padding: 10 }}>
        <Text style={[ty.small, { color: C.muted }]}>{t.aboutRow}</Text>
      </Pressable>
    </Screen>
  );
}

function Alert2({ icon, color, text }: { icon: keyof typeof MaterialCommunityIcons.glyphMap; color: string; text: string }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}>
      <Icon name={icon} size={16} color={color} style={{ marginTop: 2 }} />
      <Text style={[ty.small, { flex: 1, color }]}>{text}</Text>
    </View>
  );
}
