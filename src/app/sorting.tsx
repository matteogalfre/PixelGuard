import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Pressable, Switch, Text, View } from 'react-native';

import { lang, t } from '../i18n';
import { folderFor, joinPath, LAYOUTS, type Layout, type Sortable } from '../logic';
import { useApp } from '../state';
import { C, Card, F, Header, Screen, t as ty, tap } from '../ui/kit';

const ICONS: Record<Layout, keyof typeof MaterialCommunityIcons.glyphMap> = {
  month: 'calendar-month-outline',
  yearMonth: 'calendar-blank-multiple',
  year: 'calendar-outline',
  albumMonth: 'image-album',
  flat: 'folder-outline',
};

/** Si la galerie est vide (ou l'aperçu web), on montre des noms types. */
const FALLBACK: (Sortable & { name: string })[] = [
  { name: '20261125_093012.jpg', taken: 0, modified: 0, bucketName: 'Camera', video: false },
  { name: 'VID-20261102-WA0004.mp4', taken: 0, modified: 0, bucketName: 'WhatsApp Video', video: true },
];

export default function SortingScreen() {
  const { sorting, setSorting, pc, stats } = useApp();
  const samples = stats?.samples.length ? stats.samples : FALLBACK;
  const root = pc.share ? joinPath(pc.share, pc.folder) : t.root;

  return (
    <Screen>
      <Header title={t.sortingTitle} subtitle={t.sortingSub} />

      <Card style={{ gap: 8 }}>
        <Text style={ty.label}>{t.preview}</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <MaterialCommunityIcons name="folder-network" size={18} color={C.cyan} />
          <Text style={[ty.mono, { color: C.text }]} numberOfLines={1}>{root.replace(/\//g, '\\')}</Text>
        </View>
        {samples.map((m) => {
          const dir = folderFor(m, sorting, lang);
          const parts = dir ? dir.split('/') : [];
          return (
            <View key={m.name} style={{ gap: 2 }}>
              {parts.map((part, i) => (
                <View key={i} style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 14 + i * 16 }}>
                  <MaterialCommunityIcons name="folder" size={16} color={C.violet} />
                  <Text style={[ty.mono, { color: C.text }]}>{part}</Text>
                </View>
              ))}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingLeft: 14 + parts.length * 16 }}>
                <MaterialCommunityIcons name={m.video ? 'file-video-outline' : 'file-image-outline'} size={16} color={C.muted} />
                <Text style={ty.mono} numberOfLines={1}>{m.name}</Text>
              </View>
            </View>
          );
        })}
      </Card>

      {LAYOUTS.map((l) => {
        const on = sorting.layout === l;
        const [name, hint] = t.layouts[l];
        return (
          <Pressable
            key={l}
            onPress={() => {
              tap();
              setSorting({ ...sorting, layout: l });
            }}
            style={({ pressed }) => ({
              flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderRadius: 20,
              backgroundColor: on ? 'rgba(34,195,240,0.10)' : pressed ? C.surfaceHi : C.surface,
              borderWidth: 1, borderColor: on ? C.cyan : C.line,
            })}
          >
            <MaterialCommunityIcons name={ICONS[l]} size={24} color={on ? C.cyan : C.muted} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[ty.h3, on && { color: C.cyan }]}>{name}</Text>
              <Text style={ty.small}>{hint}</Text>
            </View>
            <MaterialCommunityIcons name={on ? 'radiobox-marked' : 'radiobox-blank'} size={22} color={on ? C.cyan : C.faint} />
          </Pressable>
        );
      })}

      <Card style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <MaterialCommunityIcons name="file-tree-outline" size={24} color={C.violet} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={ty.h3}>{t.splitKinds}</Text>
          <Text style={ty.small}>{t.splitKindsHint}</Text>
        </View>
        <Switch
          value={sorting.splitKinds}
          onValueChange={(v) => {
            tap();
            setSorting({ ...sorting, splitKinds: v });
          }}
          trackColor={{ true: C.cyan, false: C.line }}
          thumbColor="#fff"
        />
      </Card>

      <Text style={[ty.hint, { fontFamily: F.regular }]}>{t.sortingNote}</Text>
    </Screen>
  );
}
