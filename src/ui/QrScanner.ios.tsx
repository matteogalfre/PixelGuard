import { CameraView, useCameraPermissions } from 'expo-camera';
import { useEffect, useRef } from 'react';
import { Linking, Modal, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { t } from '../i18n';
import { Icon, C, F, MainButton, t as ty } from './kit';
import type { QrScannerProps } from './QrScanner';

/** iPhone : expo-camera, qui lit les QR avec AVFoundation (rien ne part chez Apple ni ailleurs). */
export function QrScanner({ visible, onCode, onClose }: QrScannerProps) {
  const insets = useSafeAreaInsets();
  const [perm, request] = useCameraPermissions();
  const done = useRef(false);

  useEffect(() => {
    if (!visible) return;
    done.current = false;
    if (perm && !perm.granted && perm.canAskAgain) request();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, perm?.granted]);

  const blocked = perm != null && !perm.granted && !perm.canAskAgain;
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {perm?.granted ? (
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={({ data }) => {
              if (done.current) return;
              done.current = true;
              onCode(data);
            }}
          />
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 16 }}>
            <Icon name="camera-off-outline" size={40} color={C.muted} />
            <Text style={[ty.body, { textAlign: 'center', color: '#FFFFFF' }]}>{blocked ? t.cameraBlocked : t.cameraNeeded}</Text>
            <MainButton
              label={blocked ? t.permSettings : t.cameraAllow}
              icon={blocked ? 'cog-outline' : 'camera'}
              onPress={() => (blocked ? Linking.openSettings() : request())}
            />
          </View>
        )}
        <View style={{ position: 'absolute', top: insets.top + 12, left: 16, right: 16, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={t.close}
            style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' }}
          >
            <Icon name="close" size={24} color="#fff" />
          </Pressable>
          <Text style={{ flex: 1, color: '#fff', fontFamily: F.semi, fontSize: 15 }}>{t.scanPrompt}</Text>
        </View>
      </View>
    </Modal>
  );
}
