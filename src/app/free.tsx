import { MaterialCommunityIcons } from '@expo/vector-icons';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Text, View } from 'react-native';

import {
  findFreeCandidates,
  moveToTrash,
  stop,
  verifyCandidates,
  type FreeCandidate,
  type Progress,
} from '../engine';
import { lang, t } from '../i18n';
import { humanBytes, humanDuration } from '../logic';
import { errorMessage } from '../native';
import { useApp } from '../state';
import { C, Card, Header, MainButton, Ring, Screen, Segmented, success, t as ty, Thumb } from '../ui/kit';

const size = (n: number) => humanBytes(n, lang);

export default function Free() {
  const app = useApp();
  const [age, setAge] = useState(30);
  const [candidates, setCandidates] = useState<FreeCandidate[] | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const look = useCallback(async () => {
    setCandidates(null);
    try {
      setCandidates(await findFreeCandidates(app.selected, app.kinds, age));
    } catch (e) {
      Alert.alert('PixelGuard', errorMessage(e));
    }
  }, [app.selected, app.kinds, age]);

  useEffect(() => {
    look();
  }, [look]);

  const bytes = (candidates ?? []).reduce((n, c) => n + c.item.size, 0);

  async function free() {
    if (!candidates?.length) return;
    setMessage(null);
    await activateKeepAwakeAsync('pixelguard-free').catch(() => {});
    try {
      const v = await verifyCandidates({ pc: app.pc, password: app.password, candidates, onProgress: setProgress });
      setProgress(null);
      const notes: string[] = [];
      if (!v.cancelled && v.same.length) {
        const ok = await moveToTrash(v.same);
        notes.push(ok ? t.freeDone(v.same.length, size(v.same.reduce((n, c) => n + c.item.size, 0))) : t.freeRefused);
        if (ok) success();
      }
      if (v.different.length) notes.push(t.freeDifferent(v.different.length));
      setMessage(notes.join('\n') || t.freeRefused);
      await look();
      app.refresh();
    } catch (e) {
      Alert.alert('PixelGuard', errorMessage(e));
    } finally {
      deactivateKeepAwake('pixelguard-free');
      setProgress(null);
    }
  }

  if (progress) {
    const ratio = progress.totalBytes ? progress.doneBytes / progress.totalBytes : 0;
    const current = progress.live[0];
    return (
      <Screen>
        <View style={{ height: 8 }} />
        <Text style={ty.label}>{t.phase.verify}</Text>
        <View style={{ alignItems: 'center', marginVertical: 8 }}>
          <Ring value={ratio} size={230} stroke={16}>
            <Text style={ty.big}>{Math.floor(ratio * 100)} %</Text>
            <Text style={ty.small}>{t.files(progress.doneFiles, progress.totalFiles)}</Text>
          </Ring>
        </View>
        <Text style={[ty.small, { textAlign: 'center' }]}>
          {size(progress.speed)}/s · {t.left(humanDuration(progress.eta))}
        </Text>
        {current ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <Thumb uri={current.uri} size={52} />
            <Text style={[ty.mono, { flex: 1 }]} numberOfLines={1}>{current.name}</Text>
          </View>
        ) : null}
        <MainButton label={t.stop} kind="ghost" icon="stop-circle-outline" onPress={stop} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Header title={t.freeTitle} subtitle={t.freeText} />
      <Text style={ty.label}>{t.olderThan}</Text>
      <Segmented options={[0, 30, 90, 365].map((d) => ({ value: d, label: t.ages[d] }))} value={age} onChange={setAge} />

      <Card style={{ alignItems: 'center', paddingVertical: 28, gap: 6 }}>
        <MaterialCommunityIcons name="broom" size={30} color={C.violet} />
        {candidates == null ? (
          <Text style={ty.small}>…</Text>
        ) : candidates.length ? (
          <>
            <Text style={ty.big}>{size(bytes)}</Text>
            <Text style={ty.small}>{t.freeCount(candidates.length)}</Text>
            <View style={{ flexDirection: 'row', marginTop: 8 }}>
              {candidates.slice(0, 6).map((c, i) => (
                <Thumb key={c.item.id} uri={c.item.uri} size={40} radius={20} style={{ marginLeft: i ? -10 : 0, borderWidth: 2, borderColor: C.bg }} />
              ))}
            </View>
          </>
        ) : (
          <Text style={[ty.sub, { textAlign: 'center' }]}>{t.freeNone}</Text>
        )}
      </Card>

      {message ? <Text style={[ty.body, { color: C.ok }]}>{message}</Text> : null}

      <MainButton label={t.freeVerify} icon="shield-check-outline" kind="gradient" onPress={free} disabled={!candidates?.length || !app.pc.host} />
    </Screen>
  );
}
