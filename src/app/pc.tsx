import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Redirect, router } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { t } from '../i18n';
import { useApp } from '../state';
import { C, F, Header, MainButton, Screen, t as ty, tap } from '../ui/kit';

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
          <Pressable
            key={p.id}
            onPress={() => {
              tap();
              app.setActivePc(p.id);
            }}
            style={({ pressed }) => ({
              flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, borderRadius: 20,
              backgroundColor: on ? 'rgba(124,108,255,0.14)' : pressed ? C.surfaceHi : C.surface,
              borderWidth: 1, borderColor: on ? C.accent : C.line,
            })}
          >
            <MaterialCommunityIcons name={on ? 'radiobox-marked' : 'radiobox-blank'} size={22} color={on ? C.accent : C.faint} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[ty.h3, on && { color: C.accent }]} numberOfLines={1}>{p.name || p.host}</Text>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <MaterialCommunityIcons name={p.encrypt ? 'lock' : 'lock-open-variant-outline'} size={13} color={C.muted} />
                <Text style={ty.small} numberOfLines={1}>
                  {p.share}{p.folder ? ` › ${p.folder}` : ''}{on ? ` · ${t.active}` : ''}
                </Text>
              </View>
            </View>
            <Pressable
              onPress={() => {
                tap();
                router.push(`/pc-edit?id=${p.id}`);
              }}
              hitSlop={10}
            >
              <Text style={{ color: C.accent, fontFamily: F.semi }}>{t.edit}</Text>
            </Pressable>
          </Pressable>
        );
      })}
      <MainButton label={t.addPc} kind="ghost" icon="plus" onPress={() => router.push('/pc-edit?id=new')} />
    </Screen>
  );
}
