import { requireOptionalNativeModule } from 'expo';

import type { Album, MediaItem, PgApi } from '../modules/pgnative';

export type {
  Album,
  FoundPc,
  LoginInfo,
  MediaItem,
  RemoteEntry,
  SmbSettings,
  SpeedResult,
  VerifyResult,
} from '../modules/pgnative';

const real = requireOptionalNativeModule<PgApi>('PgNative');

/** Faux module pour voir les écrans dans le navigateur (aucun fichier ne bouge). */
function demo(): PgApi {
  const listeners = new Set<(e: { id: string; bytes: number }) => void>();
  const remote = new Map<string, number>();
  const texts = new Map<string, string>();
  let stop = false;
  const albums: Album[] = [
    { id: 'cam', name: 'Camera', path: 'DCIM/Camera/', count: 64, bytes: 64 * 4.2e6, cover: '' },
    { id: 'wa', name: 'WhatsApp Images', path: 'Android/media/com.whatsapp/WhatsApp/Media/WhatsApp Images/', count: 40, bytes: 40 * 2.1e5, cover: '' },
    { id: 'shot', name: 'Screenshots', path: 'DCIM/Screenshots/', count: 25, bytes: 25 * 9e5, cover: '' },
    { id: 'dl', name: 'Download', path: 'Download/', count: 12, bytes: 12 * 1.5e6, cover: '' },
  ];
  const media: MediaItem[] = albums.flatMap((a) =>
    Array.from({ length: a.count }, (_, i) => {
      const t = Date.now() - i * 5 * 86400e3;
      const d = new Date(t);
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      return {
        id: `${a.id}-${i}`,
        name: a.id === 'wa' ? `IMG-${stamp}-WA${String(i).padStart(4, '0')}.jpg` : `${stamp}_1200${String(i).padStart(2, '0')}.jpg`,
        size: Math.round(a.bytes / a.count),
        taken: t,
        modified: t,
        video: false,
        bucketId: a.id,
        bucketName: a.name,
        relativePath: a.path,
        uri: '',
      };
    }),
  );
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const fail = (code: string, message: string) => Object.assign(new Error(message), { code });
  return {
    async listAlbums() { await wait(150); return albums; },
    async listMedia(ids) { await wait(300); return media.filter((m) => ids.includes(m.bucketId)); },
    async discover() {
      await wait(1400);
      return [{ ip: '192.168.1.20', name: 'DESKTOP-SALON' }, { ip: '192.168.1.42', name: 'NAS' }];
    },
    async probe(host) { await wait(300); return !!host; },
    async login(s) {
      await wait(500);
      if (!s.host) throw fail('UNREACHABLE', 'PC injoignable');
      if (!s.user) throw fail('AUTH', 'Utilisateur ou mot de passe refusé par le PC');
      return { dialect: 'SMB_3_1_1', signed: true, encrypted: true, shares: ['Admin’s Public Folder', 'PixelGuard', 'Users'] };
    },
    async connect(s) {
      await wait(300);
      if (!s.host) throw fail('UNREACHABLE', 'PC injoignable');
      return { dialect: 'SMB_3_1_1', signed: true, encrypted: true, shares: null };
    },
    async disconnect() { return true; },
    async list(dir) {
      const prefix = dir.toLowerCase() + '/';
      return [...remote.entries()]
        .filter(([p]) => p.toLowerCase().startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map(([p, size]) => ({ name: p.slice(prefix.length), size, dir: false }));
    },
    async mkdirs() { return true; },
    async testWrite() { await wait(200); return { ok: true }; },
    async speedTest(_dir, mb) {
      const total = mb * 1048576;
      for (let sent = 0; sent < total; sent += 4 * 1048576) {
        await wait(50);
        listeners.forEach((l) => l({ id: 'speed', bytes: sent }));
      }
      return { bytes: total, seconds: total / 62e6, dialect: 'SMB_3_1_1', signed: true, encrypted: true, signingCrypto: 'système', maxWrite: 8388608 };
    },
    async upload(_uri, path, size, id) {
      for (let sent = 0; sent < size; sent += 1.2e6) {
        if (stop) throw fail('CANCELLED', 'Arrêté');
        await wait(40);
        listeners.forEach((l) => l({ id, bytes: Math.min(sent, size) }));
      }
      remote.set(path, size);
      return { bytes: size };
    },
    async verify(_uri, path) { await wait(30); return { same: remote.has(path), local: 'x', remote: 'x', missing: !remote.has(path) }; },
    cancel() { stop = true; },
    resetCancel() { stop = false; },
    holdWifi() {},
    startTransferService() {},
    updateTransferService() {},
    stopTransferService() {},
    async removeFromPhone() { await wait(300); return true; },
    async saveText(n, t) { texts.set(n, t); return true; },
    async loadText(n) { return texts.get(n) ?? null; },
    addListener(e: string, cb: (x: { id: string; bytes: number }) => void) {
      if (e !== 'onProgress') return { remove: () => {} };
      listeners.add(cb);
      return { remove: () => listeners.delete(cb) };
    },
  };
}

export const isDemo = real == null;
export const Pg: PgApi = real ?? demo();

export function errorCode(e: unknown): string {
  return (e as { code?: string })?.code ?? '';
}

export function errorMessage(e: unknown): string {
  const m = (e as { message?: string })?.message ?? String(e);
  // Les erreurs natives arrivent parfois préfixées du nom de la fonction.
  return m.replace(/^Call to function '[^']+' has been rejected\.\s*→ Caused by: /, '').replace(/^.*?Error: /, '');
}
