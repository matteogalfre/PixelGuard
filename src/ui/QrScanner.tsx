import { useEffect } from 'react';

export type QrScannerProps = { visible: boolean; onCode: (text: string) => void; onClose: () => void };

/** Aperçu navigateur : pas d'appareil photo, on fait comme si le code du PC de démo était lu. */
export function QrScanner({ visible, onCode }: QrScannerProps) {
  useEffect(() => {
    if (!visible) return;
    const timer = setTimeout(
      () => onCode('pixelguard://pair?v=1&h=192.168.1.20&n=DESKTOP-SALON&s=PixelGuard&u=pixelguard&p=demo-demo-demo-demo'),
      600,
    );
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);
  return null;
}
