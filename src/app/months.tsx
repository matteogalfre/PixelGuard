import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { shortMonth, t } from '../i18n';
import { errorMessage } from '../native';
import { monthsMap, readDiskReport, type MonthRow } from '../pcTools';
import { useApp } from '../state';
import { C, Card, Header, Icon, Screen, t as ty } from '../ui/kit';

function Cell({ value, warn, ok }: { value: string; warn?: boolean; ok?: boolean }) {
  return (
    <Text style={[ty.body, { width: 64, textAlign: 'right', color: warn ? C.warn : ok ? C.ok : C.text }]} numberOfLines={1}>
      {value}
    </Text>
  );
}

export default function Months() {
  const app = useApp();
  const [rows, setRows] = useState<MonthRow[] | null>(null);
  const [hasDisk, setHasDisk] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      // Sans PC joignable, la carte se fait quand même avec ce que le téléphone sait.
      const report = await readDiskReport(app.pc, app.password).catch(() => null);
      const list = await monthsMap({ pc: app.pc, albumIds: app.selected, kinds: app.kinds, report });
      if (!alive) return;
      setHasDisk(!!report);
      setRows(list);
    })().catch((e) => alive && setError(errorMessage(e)));
    return () => {
      alive = false;
    };
  }, [app.pc, app.password, app.selected, app.kinds]);

  return (
    <Screen>
      <Header title={t.tools.months} subtitle={t.tools.monthsText} />
      {error ? <Text style={[ty.small, { color: C.danger }]}>{error}</Text> : null}
      {!hasDisk && rows ? <Text style={ty.hint}>{t.tools.monthsNoDisk}</Text> : null}
      {rows && rows.length === 0 ? <Text style={ty.sub}>{t.tools.monthsEmpty}</Text> : null}
      {rows && rows.length ? (
        <Card style={{ gap: 0, paddingVertical: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 6 }}>
            <Text style={[ty.label, { flex: 1 }]}> </Text>
            <Text style={[ty.label, { width: 64, textAlign: 'right' }]}>{t.tools.monthsPhone}</Text>
            <Text style={[ty.label, { width: 64, textAlign: 'right' }]}>{t.tools.monthsPc}</Text>
            <Text style={[ty.label, { width: 64, textAlign: 'right' }]}>{t.tools.monthsDisk}</Text>
          </View>
          {rows.map((r) => {
            // Un trou : des photos du téléphone pas encore sur le PC, ou un PC en avance sur le disque.
            const phoneGap = r.phone > r.saved;
            const diskGap = r.pc != null && r.disk != null && r.pc > r.disk;
            return (
              <View
                key={r.key}
                accessible
                accessibilityLabel={`${shortMonth(r.key)} : ${t.tools.monthsPhone} ${r.saved}/${r.phone}, ${t.tools.monthsPc} ${r.pc ?? '—'}, ${t.tools.monthsDisk} ${r.disk ?? '—'}`}
                style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderTopWidth: 1, borderTopColor: C.line }}
              >
                <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  {phoneGap || diskGap ? <Icon name="alert-circle-outline" size={16} color={C.warn} /> : <Icon name="check" size={16} color={C.ok} />}
                  <Text style={ty.h3}>{shortMonth(r.key)}</Text>
                </View>
                <Cell value={r.phone ? `${r.saved}/${r.phone}` : '—'} warn={phoneGap} ok={!phoneGap && r.phone > 0} />
                <Cell value={r.pc == null ? '—' : String(r.pc)} />
                <Cell value={r.disk == null ? '—' : String(r.disk)} warn={diskGap} />
              </View>
            );
          })}
        </Card>
      ) : null}
      {!rows && !error ? <Text style={ty.small}>…</Text> : null}
    </Screen>
  );
}
