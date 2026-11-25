import { MaterialCommunityIcons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, ScrollView, Text, View } from 'react-native';

import { lang, periodLabel, shortMonth, t } from '../i18n';
import { humanBytes, periodRange, ym, type Period } from '../logic';
import { useApp } from '../state';
import { C, Card, F, Header, MainButton, Screen, t as ty, tap } from '../ui/kit';

const same = (a: Period, b: Period) => JSON.stringify(a) === JSON.stringify(b);

// Choisir la période : raccourcis, une année, ou de tel mois à tel mois. Le nombre de fichiers
// suit en direct, d'après les mois présents dans les albums choisis.
export default function PeriodScreen() {
  const app = useApp();
  const [period, setPeriod] = useState<Period>(app.period);
  const months = useMemo(() => app.stats?.months ?? [], [app.stats]);
  const keys = months.map((m) => ym(m.year, m.month)); // du plus récent au plus ancien
  const years = [...new Set(months.map((m) => m.year))];
  const initial = periodRange(app.period);
  const [from, setFrom] = useState<number | null>(app.period.kind === 'range' && initial ? initial[0] : null);
  const [to, setTo] = useState<number | null>(app.period.kind === 'range' && initial ? initial[1] : null);

  const range = periodRange(period);
  const count = months
    .filter((m) => !range || (ym(m.year, m.month) >= range[0] && ym(m.year, m.month) <= range[1]))
    .reduce((acc, m) => ({ n: acc.n + m.count, bytes: acc.bytes + m.bytes }), { n: 0, bytes: 0 });

  const pick = (p: Period) => {
    tap();
    setPeriod(p);
  };
  const pickBound = (which: 'from' | 'to', k: number) => {
    tap();
    const f = which === 'from' ? k : (from ?? k);
    const tt = which === 'to' ? k : (to ?? k);
    if (which === 'from') setFrom(k);
    else setTo(k);
    setPeriod({ kind: 'range', from: f, to: tt });
  };

  const row = (p: Period, label: string) => {
    const on = same(p, period);
    return (
      <Pressable
        key={label}
        onPress={() => pick(p)}
        style={({ pressed }) => ({
          flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14, borderRadius: 14,
          backgroundColor: on ? 'rgba(124,108,255,0.14)' : pressed ? C.surfaceHi : 'transparent',
        })}
      >
        <MaterialCommunityIcons name={on ? 'radiobox-marked' : 'radiobox-blank'} size={20} color={on ? C.accent : C.faint} />
        <Text style={[ty.body, on && { color: C.accent, fontFamily: F.semi }]}>{label}</Text>
      </Pressable>
    );
  };

  const chip = (label: string, on: boolean, onPress: () => void) => (
    <Pressable
      key={label}
      onPress={onPress}
      style={{
        paddingHorizontal: 14, paddingVertical: 9, borderRadius: 16, borderWidth: 1,
        borderColor: on ? C.accent : C.line, backgroundColor: on ? 'rgba(124,108,255,0.14)' : C.surface,
      }}
    >
      <Text style={{ color: on ? C.accent : C.text, fontFamily: F.semi }}>{label}</Text>
    </Pressable>
  );

  const monthRow = (which: 'from' | 'to') => (
    <View style={{ gap: 6 }}>
      <Text style={ty.label}>{which === 'from' ? t.from : t.to}</Text>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8 }}>
        {[...keys].reverse().map((k) =>
          chip(shortMonth(k), period.kind === 'range' && (which === 'from' ? from : to) === k, () => pickBound(which, k)),
        )}
      </ScrollView>
    </View>
  );

  return (
    <Screen>
      <Header title={t.periodTitle} subtitle={t.periodSub} />

      <Card style={{ gap: 2, paddingVertical: 8 }}>
        <Text style={[ty.label, { marginHorizontal: 14, marginTop: 6 }]}>{t.shortcuts}</Text>
        {row({ kind: 'all' }, t.periods.all)}
        {row({ kind: 'thisMonth' }, t.periods.thisMonth)}
        {row({ kind: 'lastMonth' }, t.periods.lastMonth)}
        {[3, 6, 12].map((n) => row({ kind: 'lastMonths', n }, t.lastN(n)))}
      </Card>

      {years.length ? (
        <Card>
          <Text style={ty.label}>{t.years}</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {years.map((y) => chip(String(y), same(period, { kind: 'year', year: y }), () => pick({ kind: 'year', year: y })))}
          </View>
        </Card>
      ) : null}

      {keys.length ? (
        <Card style={{ gap: 12 }}>
          <Text style={ty.h3}>{t.fromTo}</Text>
          {monthRow('from')}
          {monthRow('to')}
        </Card>
      ) : null}

      <Card style={{ alignItems: 'center', gap: 4 }}>
        <Text style={[ty.h3, { color: C.accent }]}>{periodLabel(period)}</Text>
        <Text style={ty.small}>{t.periodCount(count.n, humanBytes(count.bytes, lang))}</Text>
      </Card>
      <MainButton
        label={t.apply}
        icon="check"
        onPress={() => {
          app.setPeriod(period);
          router.back();
        }}
      />
    </Screen>
  );
}
