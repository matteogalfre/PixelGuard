import { Redirect, useLocalSearchParams } from 'expo-router';

import { pairingFrom } from '../logic';
import { setPendingPairing } from '../pairing';

/**
 * Le lien du QR, ouvert par l'appareil photo du téléphone. Rien ne se connecte d'ici : l'écran
 * du PC montre ce qu'il a reçu et attend un « Ajouter ce PC » (un site pourrait ouvrir ce lien).
 */
export default function Pair() {
  const p = pairingFrom(useLocalSearchParams());
  if (p) setPendingPairing(p);
  return <Redirect href="/pc-edit?id=new" />;
}
