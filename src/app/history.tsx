import { MaterialCommunityIcons } from '@expo/vector-icons';
import { Text, View } from 'react-native';

import { ago, lang, t } from '../i18n';
import { humanBytes, humanDuration } from '../logic';
import { useApp } from '../state';
import { C, Card, Header, Screen, t as ty } from '../ui/kit';

export default function History() {
  const { history } = useApp();
  return (
    <Screen>
      <Header title={t.historyTitle} subtitle={t.historySub} />
      {history.length === 0 ? <Text style={ty.sub}>{t.historyEmpty}</Text> : null}
      {history.map((r) => {
        const color = r.failed ? C.warn : r.cancelled ? C.muted : C.ok;
        const icon = r.failed ? 'alert-circle' : r.cancelled ? 'stop-circle' : 'check-circle';
        return (
          <Card key={r.at} style={{ gap: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <MaterialCommunityIcons name={icon} size={18} color={color} />
              <Text style={[ty.h3, { flex: 1 }]}>{new Date(r.at).toLocaleString(lang === 'fr' ? 'fr-FR' : 'en-GB')}</Text>
              <Text style={ty.small}>{ago(r.at)}</Text>
            </View>
            <Text style={ty.body}>{t.historyRow(r.uploaded, r.skipped, r.failed)}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <MaterialCommunityIcons name={r.encrypted ? 'lock' : 'lock-open-variant-outline'} size={14} color={C.muted} />
              <Text style={ty.small}>
                {[
                  r.pcName,
                  t.resultTime(humanBytes(r.bytes, lang), humanDuration(r.seconds)),
                  r.seconds > 0 && r.bytes > 0 ? t.historySpeed(humanBytes(r.bytes / r.seconds, lang)) : '',
                  r.cancelled ? t.stopped : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </Text>
            </View>
          </Card>
        );
      })}
    </Screen>
  );
}
