import { Redirect, router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { t } from '../i18n';
import { useApp } from '../state';
import { Icon, C, Card, F, Header, MainButton, Screen, t as ty, tap } from '../ui/kit';

// Tes PC : on choisit où part la prochaine sauvegarde, on en ajoute ou on en modifie un.
export default function Pcs() {
  const app = useApp();
  if (app.ready && app.pcs.length === 0) return <Redirect href="/pc-edit?id=new" />;

  return (
    <Screen>
      <Header title={t.pcsTitle} subtitle={t.pcsSub} />
      {app.pcs.map((p) => {
        const on = p.id === app.pc.id;
        return (
          // Deux boutons côte à côte, pas l'un dans l'autre : le lecteur d'écran atteint les deux.
          <View
            key={p.id}
            style={{
              flexDirection: 'row', alignItems: 'center', borderRadius: 20, overflow: 'hidden',
              backgroundColor: on ? C.selected : C.surface,
              borderWidth: 1, borderColor: on ? C.accent : C.line,
            }}
          >
            <Pressable
              onPress={() => {
                tap();
                app.setActivePc(p.id);
              }}
              accessibilityRole="radio"
              accessibilityState={{ selected: on, checked: on }}
              accessibilityLabel={p.name || p.host}
              style={({ pressed }) => ({
                flex: 1, flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16,
                backgroundColor: pressed ? C.surfaceHi : 'transparent',
              })}
            >
              <Icon name={on ? 'radiobox-marked' : 'radiobox-blank'} size={22} color={on ? C.accent : C.faint} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={[ty.h3, on && { color: C.accent }]} numberOfLines={1}>{p.name || p.host}</Text>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <Icon name={p.encrypt ? 'lock' : 'lock-open-variant-outline'} size={13} color={C.muted} />
                  <Text style={ty.small} numberOfLines={1}>
                    {p.share}{p.folder ? ` › ${p.folder}` : ''}{on ? ` · ${t.active}` : ''}
                  </Text>
                </View>
              </View>
            </Pressable>
            <Pressable
              onPress={() => {
                tap();
                router.push(`/pc-edit?id=${p.id}`);
              }}
              accessibilityRole="button"
              accessibilityLabel={`${t.edit} ${p.name || p.host}`}
              style={({ pressed }) => ({
                minHeight: 44, alignSelf: 'stretch', paddingHorizontal: 16, alignItems: 'center', justifyContent: 'center',
                backgroundColor: pressed ? C.surfaceHi : 'transparent',
              })}
            >
              <Text style={{ color: C.accent, fontFamily: F.semi }}>{t.edit}</Text>
            </Pressable>
          </View>
        );
      })}
      <MainButton label={t.addPc} kind="ghost" icon="plus" onPress={() => router.push('/pc-edit?id=new')} />
      <Card onPress={() => router.push('/about')} style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginTop: 8 }}>
        <Icon name="information-outline" size={22} color={C.accent} />
        <Text style={[ty.h3, { flex: 1 }]}>{t.aboutRow}</Text>
        <Icon name="chevron-right" size={22} color={C.muted} />
      </Card>
    </Screen>
  );
}
