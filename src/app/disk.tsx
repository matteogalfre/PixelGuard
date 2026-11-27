import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';

import { ago, t } from '../i18n';
import { errorMessage } from '../native';
import { readDiskReport, sentSince, type DiskReport } from '../pcTools';
import { useApp } from '../state';
import { diskLine } from '../ui/diskLine';
import { C, Card, Dot, Header, Icon, Screen, t as ty } from '../ui/kit';

export default function Disk() {
  const app = useApp();
  const [report, setReport] = useState<DiskReport | null | undefined>(undefined);
  const [error, setError] = useState('');

  useFocusEffect(
    useCallback(() => {
      let alive = true;
      setError('');
      readDiskReport(app.pc, app.password)
        .then((r) => alive && setReport(r))
        .catch((e) => {
          if (!alive) return;
          setReport(null);
          setError(errorMessage(e));
        });
      return () => {
        alive = false;
      };
    }, [app.pc, app.password]),
  );

  const line = diskLine(report);
  const since = report ? sentSince(report, app.history) : 0;

  return (
    <Screen>
      <Header title={t.tools.disk} subtitle={report ? t.tools.diskFolder(report.label, report.path) : undefined} />
      {error ? <Text style={[ty.small, { color: C.danger }]}>{error}</Text> : null}
      {report === undefined ? <Text style={ty.small}>…</Text> : null}
      {report === null && !error ? (
        <Card style={{ gap: 10 }}>
          <Icon name="harddisk" size={26} color={C.accent} />
          <Text style={ty.h3}>{t.tools.diskNone}</Text>
          <Text style={ty.body}>{t.tools.diskHow}</Text>
        </Card>
      ) : null}
      {report ? (
        <>
          <Card style={{ gap: 8 }}>
            <Text style={[ty.h2, { color: line.color }]}>{line.text}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Dot color={report.present ? C.ok : C.faint} />
              <Text style={ty.small}>
                {report.present
                  ? t.tools.diskPlugged
                  : report.lastSeen
                    ? t.tools.diskUnplugged(ago(Date.parse(report.lastSeen)))
                    : t.tools.diskNever}
              </Text>
            </View>
            {report.lastSync ? <Text style={ty.small}>{t.tools.diskCopied(report.copied)}</Text> : null}
            {!report.present && since > 0 ? <Text style={ty.hint}>{t.tools.diskSince(since)}</Text> : null}
          </Card>
          {report.failed.length ? (
            <Card style={{ gap: 6, borderColor: C.warnLine }}>
              <Text style={[ty.h3, { color: C.warn }]}>{t.tools.diskFailed(report.failed.length)}</Text>
              {report.failed.slice(0, 30).map((f) => (
                <Text key={f} style={ty.mono} numberOfLines={1}>{f}</Text>
              ))}
            </Card>
          ) : null}
          {report.damaged.length ? (
            <Card style={{ gap: 6, borderColor: C.warnLine }}>
              <Text style={[ty.h3, { color: C.danger }]}>{t.tools.diskDamaged(report.damaged.length)}</Text>
              {report.damaged.slice(0, 30).map((f) => (
                <Text key={f} style={ty.mono} numberOfLines={1}>{f}</Text>
              ))}
            </Card>
          ) : null}
          {report.missingSample.length ? (
            <Card style={{ gap: 6 }}>
              <Text style={ty.label}>{t.tools.diskMissingList}</Text>
              {report.missingSample.slice(0, 50).map((f) => (
                <Text key={f} style={ty.mono} numberOfLines={1}>{f}</Text>
              ))}
            </Card>
          ) : null}
          <Text style={ty.hint}>{t.tools.diskHow}</Text>
        </>
      ) : null}
    </Screen>
  );
}
