import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Platform, Pressable, Text, View } from 'react-native';

import { lang, t } from '../i18n';
import { humanBytes, joinPath } from '../logic';
import { errorMessage } from '../native';
import { inBackground, isVideo, listPcDir, pcThumbnail, restoreToPhone, type PcDir, type PcFile, type ToolProgress } from '../pcTools';
import { useApp } from '../state';
import { C, Card, Header, Icon, MainButton, Screen, success, t as ty, tap, Thumb } from '../ui/kit';
import { ToolProgressView } from '../ui/ToolProgress';

const size = (n: number) => humanBytes(n, lang);

/** Une photo du PC : sa vignette EXIF quand il y en a une (64 Ko lus), sinon une icône. */
function FileTile({ file, on, onPress }: { file: PcFile; on: boolean; onPress: () => void }) {
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    pcThumbnail(file.path).then((u) => alive && setThumb(u)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [file.path]);
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="checkbox"
      accessibilityState={{ checked: on }}
      accessibilityLabel={file.name}
      style={{ width: '31%', gap: 4 }}
    >
      <View>
        <Thumb uri={thumb ?? undefined} size="100%" radius={10} style={{ aspectRatio: 1, height: undefined, opacity: on ? 1 : 0.85 }} />
        {isVideo(file.name) ? (
          <View style={{ position: 'absolute', left: 6, bottom: 6 }}>
            <Icon name="play-circle" size={20} color="#FFFFFF" />
          </View>
        ) : null}
        <View style={{ position: 'absolute', right: 6, top: 6 }}>
          <Icon name={on ? 'check-circle' : 'checkbox-blank-circle-outline'} size={22} color={on ? C.accent : '#FFFFFF'} />
        </View>
      </View>
      <Text style={ty.small} numberOfLines={1}>{file.name}</Text>
    </Pressable>
  );
}

export default function Restore() {
  const app = useApp();
  const root = app.pc.folder;
  const [dir, setDir] = useState(root);
  const [listing, setListing] = useState<PcDir | null>(null);
  const [error, setError] = useState('');
  const [chosen, setChosen] = useState<Map<string, PcFile>>(new Map());
  const [progress, setProgress] = useState<ToolProgress | null>(null);
  const [message, setMessage] = useState('');

  const load = useCallback(
    async (d: string) => {
      setListing(null);
      setError('');
      try {
        setListing(await listPcDir(app.pc, app.password, d));
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [app.pc, app.password],
  );

  useEffect(() => {
    load(dir);
  }, [dir, load]);

  const toggle = (f: PcFile) => {
    tap();
    setChosen((prev) => {
      const next = new Map(prev);
      if (next.has(f.path)) next.delete(f.path);
      else next.set(f.path, f);
      return next;
    });
  };

  const picked = [...chosen.values()];
  const pickedBytes = picked.reduce((n, f) => n + f.size, 0);

  async function run() {
    if (!picked.length) return;
    setMessage('');
    setProgress({ done: 0, total: pickedBytes });
    await activateKeepAwakeAsync('pixelguard-restore').catch(() => {});
    try {
      const r = await inBackground(t.tools.restore, () =>
        restoreToPhone({ pc: app.pc, password: app.password, files: picked, onProgress: setProgress }),
      );
      setMessage([t.tools.restoreDone(r.done), r.cancelled ? t.stopped : '', ...r.errors.slice(0, 5)].filter(Boolean).join('\n'));
      if (r.done && !r.errors.length) success();
      setChosen(new Map());
      app.refresh();
    } catch (e) {
      Alert.alert('PixelGuard', errorMessage(e));
    } finally {
      Promise.resolve(deactivateKeepAwake('pixelguard-restore')).catch(() => {});
      setProgress(null);
    }
  }

  if (progress) return <ToolProgressView title={t.tools.restore} progress={progress} />;

  const rel = dir.length > root.length ? dir.slice(root.length).replace(/^\//, '') : '';
  const allHere = listing?.files.length ? listing.files.every((f) => chosen.has(f.path)) : false;

  return (
    <Screen>
      <Header title={t.tools.restore} subtitle={t.tools.restoreText(Platform.OS === 'android')} />
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        {dir !== root ? (
          <Pressable
            onPress={() => setDir(dir.includes('/') && dir.lastIndexOf('/') >= root.length ? dir.slice(0, dir.lastIndexOf('/')) : root)}
            accessibilityRole="button"
            accessibilityLabel={t.back}
            hitSlop={12}
          >
            <Icon name="arrow-up-left" size={22} color={C.accent} />
          </Pressable>
        ) : null}
        <Text style={[ty.mono, { flex: 1 }]} numberOfLines={1}>{rel ? `${app.pc.share}/${joinPath(root, rel)}` : `${app.pc.share}/${root}`}</Text>
      </View>
      {message ? <Text style={[ty.body, { color: C.ok }]}>{message}</Text> : null}
      {error ? <Text style={[ty.small, { color: C.danger }]}>{error}</Text> : null}
      {!listing && !error ? <Text style={ty.small}>…</Text> : null}
      {listing?.dirs.map((d) => (
        <Card key={d} onPress={() => setDir(joinPath(dir, d))} style={{ flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14 }}>
          <Icon name="folder-outline" size={22} color={C.accent} />
          <Text style={[ty.h3, { flex: 1 }]} numberOfLines={1}>{d}</Text>
          <Icon name="chevron-right" size={20} color={C.muted} />
        </Card>
      ))}
      {listing && !listing.dirs.length && !listing.files.length ? <Text style={ty.sub}>{t.tools.restoreEmpty}</Text> : null}
      {listing?.files.length ? (
        <>
          <Pressable
            onPress={() =>
              setChosen((prev) => {
                const next = new Map(prev);
                for (const f of listing.files) {
                  if (allHere) next.delete(f.path);
                  else next.set(f.path, f);
                }
                return next;
              })
            }
            accessibilityRole="button"
            hitSlop={10}
            style={{ alignSelf: 'flex-end' }}
          >
            <Text style={[ty.small, { color: C.accent }]}>{allHere ? t.tools.restoreNone : t.tools.restoreAll}</Text>
          </Pressable>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
            {listing.files.slice(0, 300).map((f) => (
              <FileTile key={f.path} file={f} on={chosen.has(f.path)} onPress={() => toggle(f)} />
            ))}
          </View>
        </>
      ) : null}
      <MainButton
        label={picked.length ? t.tools.restoreRun(picked.length, size(pickedBytes)) : t.tools.restore}
        icon="download"
        onPress={run}
        disabled={!picked.length}
      />
    </Screen>
  );
}
