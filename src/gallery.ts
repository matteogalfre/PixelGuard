import { Pg, type Album, type MediaItem } from './native';

// La galerie n'est relue que si elle a changé : sur une grosse photothèque, la relire à chaque
// retour sur l'accueil prend du temps et de la batterie.
let version = '';
let albums: Album[] | null = null;
const media = new Map<string, MediaItem[]>();
let epoch = 0;

/** Change chaque fois que la copie de la galerie est oubliée : de quoi savoir qu'elle a bougé. */
export const galleryEpoch = () => epoch;

async function check(): Promise<void> {
  const v = await Pg.galleryVersion().catch(() => '');
  // "" : version inconnue, on ne garde rien.
  if (!v || v !== version) forgetGallery();
  version = v;
}

/** À l'oubli : retour dans l'appli, accès aux photos redemandé. */
export function forgetGallery(): void {
  epoch++;
  version = '';
  albums = null;
  media.clear();
}

export async function galleryAlbums(): Promise<Album[]> {
  await check();
  if (!albums) albums = await Pg.listAlbums();
  return albums;
}

export async function galleryMedia(albumIds: string[]): Promise<MediaItem[]> {
  await check();
  const key = [...albumIds].sort().join('|');
  let list = media.get(key);
  if (!list) {
    list = await Pg.listMedia(albumIds);
    if (media.size >= 4) media.clear();
    media.set(key, list);
  }
  return list;
}
