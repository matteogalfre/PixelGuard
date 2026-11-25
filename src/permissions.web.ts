export type Access = 'none' | 'limited' | 'all';

// Aperçu navigateur : pas de galerie, le faux module fournit les albums.
export async function readAccess(_request: boolean): Promise<Access> {
  return 'all';
}
