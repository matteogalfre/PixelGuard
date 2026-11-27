import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useState } from 'react';
import { Alert, Text, View } from 'react-native';

import { t } from '../i18n';
import { errorMessage } from '../native';
import { checkCopies, inBackground, type CheckResult, type ToolProgress } from '../pcTools';
import { useApp } from '../state';
import { C, Card, Header, Icon, MainButton, Screen, success, t as ty } from '../ui/kit';
import { ToolProgressView } from '../ui/ToolProgress';

export default function Check() {
  const app = useApp();
  const [progress, setProgress] = useState<ToolProgress | null>(null);
  const [result, setResult] = useState<CheckResult | null>(null);

  async function run() {
    setResult(null);
    setProgress({ done: 0, total: 0 });
    await activateKeepAwakeAsync('pixelguard-check').catch(() => {});
    try {
      const r = await inBackground(t.tools.check, () => checkCopies({ pc: app.pc, password: app.password, onProgress: setProgress }));
      setResult(r);
      if (!r.cancelled && r.checked && !r.missing.length && !r.damaged.length) success();
    } catch (e) {
      Alert.alert('PixelGuard', errorMessage(e));
    } finally {
      Promise.resolve(deactivateKeepAwake('pixelguard-check')).catch(() => {});
      setProgress(null);
    }
  }

  if (progress) return <ToolProgressView title={t.tools.check} progress={progress} />;

  const problems = result ? [...result.missing, ...result.damaged] : [];
  return (
    <Screen>
      <Header title={t.tools.check} subtitle={t.tools.checkText} />
      {result ? (
        <Card style={{ gap: 8, borderColor: problems.length ? C.warnLine : C.okLine }}>
          {result.checked === 0 && !result.cancelled ? <Text style={ty.body}>{t.tools.checkNothing}</Text> : null}
          {result.ok ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Icon name="check-circle" size={18} color={C.ok} />
              <Text style={ty.body}>{t.tools.checkOk(result.ok)}</Text>
            </View>
          ) : null}
          {result.missing.length ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Icon name="help-circle" size={18} color={C.warn} />
              <Text style={ty.body}>{t.tools.checkMissing(result.missing.length)}</Text>
            </View>
          ) : null}
          {result.damaged.length ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <Icon name="alert-circle" size={18} color={C.danger} />
              <Text style={ty.body}>{t.tools.checkDamaged(result.damaged.length)}</Text>
            </View>
          ) : null}
          {result.cancelled ? <Text style={[ty.small, { color: C.warn }]}>{t.stopped}</Text> : null}
          {result.noPrint ? <Text style={ty.hint}>{t.tools.checkNoPrint(result.noPrint)}</Text> : null}
          {problems.slice(0, 40).map((p) => (
            <Text key={p} style={ty.mono} numberOfLines={1}>{p}</Text>
          ))}
          {problems.length ? <Text style={ty.hint}>{t.tools.checkAdvice}</Text> : null}
        </Card>
      ) : null}
      <MainButton label={t.tools.checkRun} icon="shield-check-outline" onPress={run} disabled={!app.pc.host} />
    </Screen>
  );
}
