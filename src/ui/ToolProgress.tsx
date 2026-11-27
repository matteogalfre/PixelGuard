import { Text, View } from 'react-native';

import { lang, t } from '../i18n';
import { humanBytes } from '../logic';
import { stopTools, type ToolProgress } from '../pcTools';
import { MainButton, Ring, Screen, t as ty } from './kit';

/** L'écran d'attente commun aux outils du PC : anneau, fichier en cours, Arrêter. */
export function ToolProgressView({ title, progress, bytes = true }: { title: string; progress: ToolProgress; bytes?: boolean }) {
  const ratio = progress.total ? progress.done / progress.total : 0;
  const pct = `${Math.floor(ratio * 100)} %`;
  const amount = bytes
    ? `${humanBytes(progress.done, lang)} / ${humanBytes(progress.total, lang)}`
    : `${progress.done} / ${progress.total}`;
  return (
    <Screen>
      <View style={{ height: 8 }} />
      <Text style={ty.label}>{title}</Text>
      <View style={{ alignItems: 'center', marginVertical: 8 }}>
        <Ring value={ratio} size={220} stroke={16} label={progress.total ? `${pct}, ${amount}` : t.tools.working}>
          {progress.total ? (
            <>
              <Text style={ty.big} maxFontSizeMultiplier={1.3}>{pct}</Text>
              <Text style={ty.small} maxFontSizeMultiplier={1.3}>{amount}</Text>
            </>
          ) : (
            <Text style={[ty.small, { textAlign: 'center', paddingHorizontal: 30 }]}>{progress.detail ?? t.tools.working}</Text>
          )}
        </Ring>
      </View>
      {progress.total && progress.detail ? (
        <Text style={[ty.mono, { textAlign: 'center' }]} numberOfLines={1}>{progress.detail}</Text>
      ) : null}
      <MainButton label={t.tools.stop} kind="ghost" icon="stop-circle-outline" onPress={stopTools} />
    </Screen>
  );
}
