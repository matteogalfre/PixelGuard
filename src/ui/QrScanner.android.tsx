import { useEffect } from 'react';

import { t } from '../i18n';
import { Pg } from '../native';
import type { QrScannerProps } from './QrScanner';

/** Android : le lecteur ZXing du module natif (expo-camera passerait par ML Kit, qui parle à Google). */
export function QrScanner({ visible, onCode, onClose }: QrScannerProps) {
  useEffect(() => {
    if (!visible) return;
    let live = true;
    (Pg.scanQr ? Pg.scanQr(t.scanPrompt) : Promise.resolve(null))
      .then((text) => {
        if (!live) return;
        if (text) onCode(text);
        else onClose();
      })
      .catch(() => live && onClose());
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  return null;
}
