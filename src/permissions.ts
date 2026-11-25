import * as MediaLibrary from 'expo-media-library';

export type Access = 'none' | 'limited' | 'all';

/** Photos et vidéos, plus la position des médias (sinon Android retire le GPS). */
export async function readAccess(request: boolean): Promise<Access> {
  const r = request
    ? await MediaLibrary.requestPermissionsAsync(false, ['photo', 'video'])
    : await MediaLibrary.getPermissionsAsync(false, ['photo', 'video']);
  if (!r.granted) return 'none';
  return r.accessPrivileges === 'limited' ? 'limited' : 'all';
}
