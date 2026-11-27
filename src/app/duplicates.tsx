import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';

import { lang, t } from '../i18n';
import { humanBytes } from '../logic';
import { errorMessage } from '../native';
import { findDuplicates, inBackground, moveDuplicates, pcThumbnail, type DupGroup, type ToolProgress } from '../pcTools';
import { useApp } from '../state';
import { C, Card, Header, Icon, MainButton, Screen, success, t as ty, tap, Thumb } from '../ui/kit';
import { ToolProgressView } from '../ui/ToolProgress';

const size = (n: number) => humanBytes(n, lang);
const keyOf = (g: DupGroup) => `${g.md5}|${g.size}`;

function awake(on: boolean) {
  if (on) return activateKeepAwakeAsync('pixelguard-dups').catch(() => {});
  return Promise.resolve(deactivateKeepAwake('pixelguard-dups')).catch(() => {});
}

function GroupCard({ group, keep, onKeep }: { group: DupGroup; keep: string; onKeep: (path: string) => void }) {
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    pcThumbnail(group.files[0].path).then((u) => alive && setThumb(u)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [group]);
  const name = group.files[0].name;
  return (
    <Card style={{ gap: 10 }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
        <Thumb uri={thumb ?? undefined} size={52} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={ty.h3} numberOfLines={1}>{name}</Text>
          <Text style={ty.small}>
            {size(group.size)}
            {group.taken ? ` · ${t.tools.dupsTaken(new Date(group.taken).toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-GB'))}` : ''}
          </Text>
        </View>
      </View>
      {group.files.map((f) => {
        const on = keep === f.path;
        const recommended = group.keep === f.path;
        return (
          <Pressable
            key={f.path}
            onPress={() => {
              tap();
              onKeep(f.path);
            }}
            accessibilityRole="radio"
            accessibilityState={{ checked: on }}
            accessibilityLabel={`${t.tools.dupsKeep} ${f.path}`}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}
          >
            <Icon name={on ? 'radiobox-marked' : 'radiobox-blank'} size={22} color={on ? C.accent : C.muted} />
            <View style={{ flex: 1 }}>
              <Text style={ty.mono} numberOfLines={2}>{f.path}</Text>
              {recommended ? (
                <Text style={[ty.small, { color: C.ok }]}>
                  {t.tools.dupsKeep} · {t.tools.dupsReason[group.reason]}
                </Text>
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </Card>
  );
}

export default function Duplicates() {
  const app = useApp();
  const [progress, setProgress] = useState<(ToolProgress & { phase?: 'list' | 'hash' }) | null>(null);
  const [groups, setGroups] = useState<DupGroup[] | null>(null);
  const [keep, setKeep] = useState<Map<string, string>>(new Map());
  const [message, setMessage] = useState('');

  async function scan() {
    setMessage('');
    setGroups(null);
    setProgress({ done: 0, total: 0 });
    await awake(true);
    try {
      const found = await inBackground(t.tools.dups, () =>
        findDuplicates({ pc: app.pc, password: app.password, sorting: app.sorting, lang, onProgress: setProgress }),
      );
      setGroups(found);
      setKeep(new Map(found.map((g) => [keyOf(g), g.keep])));
    } catch (e) {
      if ((e as { code?: string }).code !== 'CANCELLED') Alert.alert('PixelGuard', errorMessage(e));
    } finally {
      await awake(false);
      setProgress(null);
    }
  }

  const extra = (groups ?? []).reduce((n, g) => n + g.files.length - 1, 0);
  const extraBytes = (groups ?? []).reduce((n, g) => n + (g.files.length - 1) * g.size, 0);

  function confirmMove() {
    if (!groups?.length) return;
    Alert.alert(t.tools.dupsConfirmTitle, t.tools.dupsConfirm(extra), [
      { text: t.cancel, style: 'cancel' },
      { text: t.tools.dupsMove(extra), onPress: move },
    ]);
  }

  async function move() {
    if (!groups) return;
    setProgress({ done: 0, total: extra });
    await awake(true);
    try {
      const r = await moveDuplicates({
        pc: app.pc,
        password: app.password,
        choices: groups.map((g) => ({ group: g, keep: keep.get(keyOf(g)) ?? g.keep })),
        onProgress: setProgress,
      });
      setMessage([t.tools.dupsDone(r.moved, size(r.bytes)), ...r.errors.slice(0, 5)].join('\n'));
      if (r.moved && !r.errors.length) success();
      setGroups(null);
    } catch (e) {
      Alert.alert('PixelGuard', errorMessage(e));
    } finally {
      await awake(false);
      setProgress(null);
    }
  }

  if (progress) {
    const listing = progress.phase === 'list';
    return (
      <ToolProgressView
        title={t.tools.dups}
        progress={listing ? { done: 0, total: 0, detail: t.tools.dupsListing(progress.done) } : progress}
        bytes={progress.phase === 'hash'}
      />
    );
  }

  return (
    <Screen>
      <Header title={t.tools.dups} subtitle={t.tools.dupsText} />
      {message ? <Text style={[ty.body, { color: C.ok }]}>{message}</Text> : null}
      {groups && groups.length === 0 ? (
        <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
          <Icon name="check-circle" size={22} color={C.ok} />
          <Text style={[ty.body, { flex: 1 }]}>{t.tools.dupsNone}</Text>
        </Card>
      ) : null}
      {groups && groups.length ? <Text style={ty.h3}>{t.tools.dupsFound(groups.length, size(extraBytes))}</Text> : null}
      {groups?.map((g) => (
        <GroupCard
          key={keyOf(g)}
          group={g}
          keep={keep.get(keyOf(g)) ?? g.keep}
          onKeep={(p) => setKeep((prev) => new Map(prev).set(keyOf(g), p))}
        />
      ))}
      {groups && groups.length ? (
        <MainButton label={t.tools.dupsMove(extra)} icon="folder-move-outline" onPress={confirmMove} />
      ) : (
        <MainButton label={t.tools.dupsScan} icon="magnify" onPress={scan} disabled={!app.pc.host} />
      )}
    </Screen>
  );
}
