import type { Pairing } from './logic';

// Un QR lu avec l'appareil photo du téléphone ouvre « pixelguard://pair?… » : on garde ses
// informations ici le temps d'ouvrir l'écran du PC, qui demande confirmation avant de s'y connecter.
let pending: Pairing | null = null;

export function setPendingPairing(p: Pairing): void {
  pending = p;
}

export function takePendingPairing(): Pairing | null {
  const p = pending;
  pending = null;
  return p;
}
