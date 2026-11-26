import * as MediaLibrary from 'expo-media-library';
import { Linking } from 'react-native';

/** `blocked` : refusé et Android ou iOS ne redemanderont plus, il faut passer par les réglages. */
export type Access = 'none' | 'blocked' | 'limited' | 'all';

/** Photos et vidéos, plus la position des médias (sinon Android retire le GPS). */
export async function readAccess(request: boolean): Promise<Access> {
  const r = request
    ? await MediaLibrary.requestPermissionsAsync(false, ['photo', 'video'])
    : await MediaLibrary.getPermissionsAsync(false, ['photo', 'video']);
  if (!r.granted) return r.canAskAgain === false ? 'blocked' : 'none';
  return r.accessPrivileges === 'limited' ? 'limited' : 'all';
}

/** Accès partiel : la fenêtre du système pour choisir d'autres photos, sinon les réglages. */
export async function widenAccess(): Promise<void> {
  try {
    await MediaLibrary.presentPermissionsPicker(['photo', 'video']);
  } catch {
    await Linking.openSettings();
  }
}

export function openSettings(): Promise<void> {
  return Linking.openSettings();
}
