import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, Text, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { lang, t } from '../i18n';
import { humanBytes } from '../logic';
import { useApp } from '../state';
import { Icon, C, F, GRADIENT, Header, MainButton, t as ty, tap, Thumb } from '../ui/kit';

const COLUMNS = 4;
const GAP = 4;

// Ce qui va partir, en grille : on touche une vignette pour la retirer de cet envoi.
export default function Review() {
  const app = useApp();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const missing = useMemo(() => app.preview?.missing ?? [], [app.preview]);
  // On travaille sur une copie, appliquée en touchant « Valider ».
  const [excluded, setExcluded] = useState(() => new Set(app.excluded));
  const cell = (width - 40 - GAP * (COLUMNS - 1)) / COLUMNS;

  const kept = missing.filter((m) => !excluded.has(m.id));
  const keptBytes = kept.reduce((n, m) => n + m.size, 0);
  const hasVideos = missing.some((m) => m.video);
  const hasPhotos = missing.some((m) => !m.video);

  const toggle = (id: string) => {
    tap();
    const next = new Set(excluded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExcluded(next);
  };
  const setAll = (keep: (video: boolean) => boolean) => {
    tap();
    setExcluded(new Set(missing.filter((m) => !keep(m.video)).map((m) => m.id)));
  };

  const chip = (label: string, onPress: () => void) => (
    <Pressable
      key={label}
      onPress={onPress}
      accessibilityRole="button"
      style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16, borderWidth: 1, borderColor: C.line, backgroundColor: C.surface }}
    >
      <Text style={{ color: C.text, fontFamily: F.semi, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <LinearGradient
        colors={[C.glow1, C.glow2, 'transparent']}
        start={{ x: 0.1, y: 0 }}
        end={{ x: 0.9, y: 0.55 }}
        style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }}
      />
      <FlatList
        data={missing}
        keyExtractor={(m) => m.id}
        numColumns={COLUMNS}
        columnWrapperStyle={{ gap: GAP }}
        contentContainerStyle={{ paddingTop: insets.top + 8, paddingHorizontal: 20, paddingBottom: 140, gap: GAP }}
        ListHeaderComponent={
          <View style={{ gap: 12, marginBottom: 12 }}>
            <Header title={t.reviewTitle} subtitle={t.reviewSub} />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {chip(t.selectAll, () => setAll(() => true))}
              {chip(t.selectNone, () => setAll(() => false))}
              {hasVideos && hasPhotos ? chip(t.noVideos, () => setAll((video) => !video)) : null}
              {hasVideos && hasPhotos ? chip(t.noPhotos, () => setAll((video) => video)) : null}
            </View>
          </View>
        }
        renderItem={({ item }) => {
          const on = !excluded.has(item.id);
          return (
            <Pressable
              onPress={() => toggle(item.id)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={item.name}
              style={{ width: cell, height: cell }}
            >
              <Thumb uri={item.uri} size={cell} radius={8} style={{ opacity: on ? 1 : 0.3 }} />
              {item.video ? (
                <Icon name="play-circle" size={20} color="#fff" style={{ position: 'absolute', left: 5, bottom: 5 }} />
              ) : null}
              <View style={{ position: 'absolute', top: 5, right: 5 }}>
                {on ? (
                  <LinearGradient colors={GRADIENT} style={{ width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="check" size={15} color="#fff" />
                  </LinearGradient>
                ) : (
                  <View style={{ width: 22, height: 22, borderRadius: 11, borderWidth: 2, borderColor: 'rgba(255,255,255,0.8)' }} />
                )}
              </View>
            </Pressable>
          );
        }}
      />
      <View
        style={{
          position: 'absolute', left: 0, right: 0, bottom: 0, padding: 20, paddingBottom: insets.bottom + 16, gap: 10,
          backgroundColor: C.bar, borderTopWidth: 1, borderTopColor: C.line,
        }}
      >
        <Text style={[ty.small, { textAlign: 'center' }]}>{t.reviewCount(kept.length, missing.length, humanBytes(keptBytes, lang))}</Text>
        <MainButton
          label={t.done}
          icon="check"
          onPress={() => {
            app.setExcluded(excluded);
            router.back();
          }}
        />
      </View>
    </View>
  );
}
