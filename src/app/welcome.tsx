import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { Pressable, Share, Text, View } from 'react-native';

import { pairFromCode } from '../engine';
import { lang, t } from '../i18n';
import { parsePairing } from '../logic';
import { prepFingerprint, usePrepServer } from '../prepServer';
import { errorMessage } from '../native';
import { useApp } from '../state';
import { newPcId } from '../store';
import { C, F, Icon, MainButton, Screen, success, t as ty, tap, Thumb } from '../ui/kit';
import { QrScanner } from '../ui/QrScanner';

const PREP_URL = 'https://github.com/matteogalfre/PixelGuard/releases/latest/download/PixelGuard-PC.cmd';

type Step = 0 | 1 | 2;

/** Premier lancement : trois écrans, un geste chacun (photos, PC, albums). */
export default function Welcome() {
  const app = useApp();
  const granted = app.access === 'all' || app.access === 'limited';
  const [step, setStep] = useState<Step>(granted ? (app.pcs.length ? 2 : 1) : 0);
  const [scanOpen, setScanOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // L'accès aux photos vient d'être donné (ici ou dans les réglages) : écran suivant.
  useEffect(() => {
    if (step === 0 && granted) setStep(1);
  }, [granted, step]);

  async function done() {
    tap();
    await app.finishWelcome();
    router.replace('/');
  }

  async function onScanned(text: string) {
    setScanOpen(false);
    const p = parsePairing(text);
    if (!p) return setError(t.scanBad);
    setError(null);
    setBusy(true);
    try {
      const r = await pairFromCode(p, { id: newPcId(), encrypt: true, lang });
      await app.savePc(r.pc, p.password);
      success();
      setStep(2);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const albums = [...app.albums].sort((a, b) => b.count - a.count).slice(0, 8);
  // À l'étape du PC, le téléphone propose lui-même « Prepare my PC » sur le Wi-Fi.
  const prepAddress = usePrepServer(step === 1);

  return (
    <Screen>
      <View
        accessible
        accessibilityLabel={t.welStep(step + 1)}
        style={{ flexDirection: 'row', gap: 6, justifyContent: 'center', marginTop: 12 }}
      >
        {[0, 1, 2].map((i) => (
          <View key={i} style={{ width: 28, height: 5, borderRadius: 3, backgroundColor: i <= step ? C.accent : C.line }} />
        ))}
      </View>

      <View style={{ alignItems: 'center', gap: 12, marginTop: 48, marginBottom: 16 }}>
        <View style={{ width: 96, height: 96, borderRadius: 30, backgroundColor: C.selected, alignItems: 'center', justifyContent: 'center' }}>
          <Icon name={step === 0 ? 'image-multiple' : step === 1 ? 'qrcode-scan' : 'folder-multiple-image'} size={46} color={C.accent} />
        </View>
        <Text style={[ty.h1, { textAlign: 'center' }]} accessibilityRole="header">
          {step === 0 ? t.welPhotosTitle : step === 1 ? t.welPcTitle : t.welAlbumsTitle}
        </Text>
        <Text style={[ty.sub, { textAlign: 'center', paddingHorizontal: 8 }]}>
          {step === 0 ? t.welPhotosText : step === 1 ? (prepAddress ? t.welPcLocal : t.welPcText) : t.welAlbumsText}
        </Text>
        {step === 1 && prepAddress ? (
          <>
            <Text selectable accessibilityLabel={prepAddress} style={[ty.h2, { color: C.accent, fontFamily: F.black, textAlign: 'center' }]}>
              {prepAddress}
            </Text>
            <Text selectable style={[ty.hint, { textAlign: 'center' }]}>{t.prepPrint(prepFingerprint)}</Text>
          </>
        ) : null}
      </View>

      {step === 0 ? (
        <>
          {app.access === 'blocked' ? <Text style={[ty.body, { color: C.warn, textAlign: 'center' }]}>{t.permBlocked}</Text> : null}
          <MainButton
            label={app.access === 'blocked' ? t.permSettings : t.welAllow}
            icon={app.access === 'blocked' ? 'cog-outline' : 'image-multiple'}
            onPress={app.requestAccess}
          />
        </>
      ) : null}

      {step === 1 ? (
        <>
          {error ? (
            <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ flexDirection: 'row', gap: 10, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: C.dangerLine }}>
              <Icon name="alert-circle-outline" size={20} color={C.danger} />
              <Text style={[ty.body, { flex: 1 }]}>{error}</Text>
            </View>
          ) : null}
          <MainButton label={t.scanButton} icon="qrcode-scan" onPress={() => setScanOpen(true)} busy={busy} />
          <MainButton
            label={t.prepSend}
            kind="ghost"
            icon="share-variant"
            onPress={() => Share.share({ message: `${t.prepShareText}\n${PREP_URL}` }).catch(() => {})}
          />
          <Pressable onPress={() => router.push('/pc-edit?id=new')} accessibilityRole="button" style={{ alignSelf: 'center', padding: 12, minHeight: 44 }}>
            <Text style={[ty.small, { color: C.accent, fontFamily: F.semi }]}>{t.welOther}</Text>
          </Pressable>
          <Pressable onPress={done} accessibilityRole="button" style={{ alignSelf: 'center', padding: 8, minHeight: 44 }}>
            <Text style={[ty.small, { color: C.muted }]}>{t.welLater}</Text>
          </Pressable>
        </>
      ) : null}

      {step === 2 ? (
        <>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, justifyContent: 'center' }}>
            {albums.map((a) => {
              const on = app.selected.includes(a.id);
              return (
                <Pressable
                  key={a.id}
                  onPress={() => {
                    tap();
                    app.setSelected(on ? app.selected.filter((x) => x !== a.id) : [...app.selected, a.id]);
                  }}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  accessibilityLabel={`${a.name}, ${a.count}`}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 48, paddingLeft: 6, paddingRight: 14,
                    borderRadius: 24, borderWidth: 1.5, borderColor: on ? C.accent : C.line,
                    backgroundColor: on ? C.selected : C.surface,
                  }}
                >
                  <Thumb uri={a.cover} size={36} radius={18} />
                  <Text style={{ color: on ? C.text : C.muted, fontFamily: F.semi, fontSize: 15 }}>{a.name || '…'}</Text>
                  {on ? <Icon name="check" size={18} color={C.accent} /> : null}
                </Pressable>
              );
            })}
          </View>
          <MainButton label={t.welGo} icon="arrow-right" onPress={done} disabled={app.selected.length === 0} />
        </>
      ) : null}

      <QrScanner visible={scanOpen} onCode={onScanned} onClose={() => setScanOpen(false)} />
    </Screen>
  );
}
