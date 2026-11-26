import { LinearGradient } from 'expo-linear-gradient';
import { Pressable, Text, View } from 'react-native';

import { router } from 'expo-router';

import { lang, periodLabel, t } from '../i18n';
import { humanBytes, type Kinds } from '../logic';
import { useApp } from '../state';
import { Icon, C, Card, F, GRADIENT, Header, Screen, Segmented, t as ty, tap, Thumb } from '../ui/kit';

export default function Sources() {
  const { albums, selected, setSelected, kinds, setKinds, stats, period } = useApp();
  const toggle = (id: string) => {
    tap();
    setSelected(selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]);
  };
  const allOn = albums.length > 0 && albums.every((a) => selected.includes(a.id));

  return (
    <Screen>
      <Header title={t.sourcesTitle} subtitle={t.sourcesSub} />

      <Text style={ty.label}>{t.kindsLabel}</Text>
      <Segmented<Kinds>
        options={(['all', 'photos', 'videos'] as Kinds[]).map((k) => ({ value: k, label: t.kinds[k] }))}
        value={kinds}
        onChange={setKinds}
      />

      <Card onPress={() => router.push('/period')} style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
        <Icon name="calendar-range" size={22} color={C.accent} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text style={ty.label}>{t.periodRow}</Text>
          <Text style={ty.h3}>{periodLabel(period)}</Text>
        </View>
        <Icon name="chevron-right" size={22} color={C.muted} />
      </Card>

      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
        <Text style={ty.label}>{t.albumsLabel}</Text>
        <Pressable
          onPress={() => {
            tap();
            setSelected(allOn ? [] : albums.map((a) => a.id));
          }}
          accessibilityRole="button"
          hitSlop={12}
        >
          <Text style={[ty.small, { color: C.accent, fontFamily: F.semi }]}>{allOn ? t.none : t.all}</Text>
        </Pressable>
      </View>
      {stats ? (
        <Text style={ty.small}>
          {stats.total} · {humanBytes(stats.totalBytes, lang)}
        </Text>
      ) : null}

      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12 }}>
        {albums.map((a) => {
          const on = selected.includes(a.id);
          return (
            <Pressable
              key={a.id}
              onPress={() => toggle(a.id)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: on }}
              accessibilityLabel={`${a.name}, ${a.count}`}
              style={({ pressed }) => ({
                width: '48%',
                aspectRatio: 1,
                borderRadius: 22,
                overflow: 'hidden',
                borderWidth: 2,
                borderColor: on ? C.accent : 'transparent',
                opacity: on ? 1 : 0.55,
                transform: [{ scale: pressed ? 0.97 : 1 }],
              })}
            >
              <Thumb uri={a.cover} size="100%" radius={0} />
              <LinearGradient
                colors={['transparent', 'rgba(0,0,0,0.85)']}
                style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: 12, paddingTop: 40 }}
              >
                <Text style={{ color: '#FFFFFF', fontFamily: F.bold, fontSize: 15 }} numberOfLines={1}>
                  {a.name || '—'}
                </Text>
                <Text style={[ty.small, { color: 'rgba(255,255,255,0.7)' }]} numberOfLines={1}>
                  {a.count} · {humanBytes(a.bytes, lang)}
                </Text>
              </LinearGradient>
              <View style={{ position: 'absolute', top: 10, right: 10 }}>
                {on ? (
                  <LinearGradient colors={GRADIENT} style={{ width: 28, height: 28, borderRadius: 14, alignItems: 'center', justifyContent: 'center' }}>
                    <Icon name="check" size={18} color="#FFFFFF" />
                  </LinearGradient>
                ) : (
                  <View style={{ width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: 'rgba(255,255,255,0.7)' }} />
                )}
              </View>
            </Pressable>
          );
        })}
      </View>
    </Screen>
  );
}
