import { router, useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';

import { t } from '../i18n';
import { readDiskReport, type DiskReport } from '../pcTools';
import { diskLine } from '../ui/diskLine';
import { useApp } from '../state';
import { C, Card, Header, Icon, Screen, t as ty } from '../ui/kit';

type Row = { icon: React.ComponentProps<typeof Icon>['name']; title: string; sub: string; href: string; color?: string };

export default function Tools() {
  const app = useApp();
  const [report, setReport] = useState<DiskReport | null | undefined>(undefined);
  const configured = !!(app.pc.host && app.pc.share);

  useFocusEffect(
    useCallback(() => {
      if (!configured) return;
      let alive = true;
      readDiskReport(app.pc, app.password)
        .then((r) => alive && setReport(r))
        .catch(() => alive && setReport(null));
      return () => {
        alive = false;
      };
    }, [configured, app.pc, app.password]),
  );

  const disk = diskLine(report);
  const rows: Row[] = [
    { icon: 'harddisk', title: t.tools.disk, sub: disk.text, href: '/disk', color: disk.color },
    { icon: 'content-duplicate', title: t.tools.dups, sub: t.tools.dupsSub, href: '/duplicates' },
    { icon: 'shield-check-outline', title: t.tools.check, sub: t.tools.checkSub, href: '/check' },
    { icon: 'calendar-month-outline', title: t.tools.months, sub: t.tools.monthsSub, href: '/months' },
    { icon: 'download-outline', title: t.tools.restore, sub: t.tools.restoreSub, href: '/restore' },
  ];

  return (
    <Screen>
      <Header title={t.tools.title} subtitle={t.tools.sub} />
      {!configured ? <Text style={ty.sub}>{t.tools.needPc}</Text> : null}
      {configured
        ? rows.map((r) => (
            <Card key={r.href} onPress={() => router.push(r.href as never)} style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
              <Icon name={r.icon} size={24} color={C.accent} />
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={ty.h3}>{r.title}</Text>
                <Text style={[ty.small, r.color ? { color: r.color } : null]} numberOfLines={2}>{r.sub}</Text>
              </View>
              <Icon name="chevron-right" size={22} color={C.muted} />
            </Card>
          ))
        : null}
    </Screen>
  );
}
