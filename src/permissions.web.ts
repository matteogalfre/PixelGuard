export type Access = 'none' | 'blocked' | 'limited' | 'all';

// Aperçu navigateur : pas de galerie, le faux module fournit les albums.
export async function readAccess(_request: boolean): Promise<Access> {
  return 'all';
}

export async function widenAccess(): Promise<void> {}

export async function openSettings(): Promise<void> {}
