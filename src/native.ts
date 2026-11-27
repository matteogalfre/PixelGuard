import { requireOptionalNativeModule } from 'expo';

import type { Album, MediaItem, PgApi } from '../modules/pgnative';
import { t } from './i18n';

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
    async galleryVersion() { return 'demo'; },
    async startPrepServer() { return { ip: '192.168.1.37', port: 8800 }; },
    async stopPrepServer() { return true; },
    async discover() {
      await wait(1400);
      return [{ ip: '192.168.1.20', name: 'DESKTOP-SALON' }, { ip: '192.168.1.42', name: 'NAS' }];
    },
    async probe(host) { await wait(300); return !!host; },
    async login(s) {
      await wait(500);
      if (!s.host) throw fail('UNREACHABLE', 'PC injoignable');
      if (!s.user) throw fail('AUTH', 'Utilisateur ou mot de passe refusé par le PC');
      return { dialect: 'SMB_3_1_1', signed: true, encrypted: true, shares: ['Admin’s Public Folder', 'PixelGuard', 'Users'], identity: 'DESKTOP-SALON' };
    },
    async connect(s) {
      await wait(300);
      if (!s.host) throw fail('UNREACHABLE', 'PC injoignable');
      if (s.identity && s.identity !== 'DESKTOP-SALON') throw fail('PC_CHANGED', 'Ce n’est pas le PC appairé');
      return { dialect: 'SMB_3_1_1', signed: true, encrypted: true, shares: null, identity: 'DESKTOP-SALON' };
    },
    async disconnect() { return true; },
    async list(dir) {
      const prefix = dir.toLowerCase() + '/';
      return [...remote.entries()]
        .filter(([p]) => p.toLowerCase().startsWith(prefix) && !p.slice(prefix.length).includes('/'))
        .map(([p, size]) => ({ name: p.slice(prefix.length), size, dir: false }));
    },
    async mkdirs() { return true; },
    async statFiles(paths) {
      const lower = new Map([...remote.entries()].map(([p, n]) => [p.toLowerCase(), n]));
      return paths.map((p) => lower.get(p.toLowerCase()) ?? -1);
    },
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
      return { bytes: size, md5: 'demo' };
    },
    async verify(_uri, path) { await wait(30); return { same: remote.has(path), local: 'x', remote: 'x', missing: !remote.has(path) }; },
    cancel() { stop = true; },
    resetCancel() { stop = false; },
    holdWifi() {},
    startTransferService() {},
    updateTransferService() {},
    stopTransferService() {},
    async removeFromPhone(uris) { await wait(300); return uris; },
    async saveText(n, t) { texts.set(n, t); return true; },
    async loadText(n) { return texts.get(n) ?? null; },
    addListener(e: string, cb: (x: never) => void) {
      if (e !== 'onProgress') return { remove: () => {} };
      const l = cb as (x: { id: string; bytes: number }) => void;
      listeners.add(l);
      return { remove: () => listeners.delete(l) };
    },
  };
}

export const isDemo = real == null;
export const Pg: PgApi = real ?? demo();

export function errorCode(e: unknown): string {
  return (e as { code?: string })?.code ?? '';
}

/** Le message tel que le module natif l'a écrit (en français, parfois technique). */
export function rawMessage(e: unknown): string {
  const m = (e as { message?: string })?.message ?? String(e);
  // Les erreurs natives arrivent parfois préfixées du nom de la fonction.
  return m.replace(/^Call to function '[^']+' has been rejected\.\s*→ Caused by: /, '').replace(/^.*?Error: /, '');
}

/** Un message à montrer : dans la langue du téléphone, sans « STATUS_… » brut quand on sait dire mieux. */
export function errorMessage(e: unknown): string {
  const raw = rawMessage(e);
  switch (errorCode(e)) {
    case 'UNREACHABLE':
      return t.err.unreachable;
    case 'NOT_LOCAL':
      return t.err.notLocal;
    case 'AUTH':
      return t.err.auth;
    case 'SHARE':
    case 'NOT_DISK':
      return t.err.share;
    case 'CONNECTION':
    case 'NOT_CONNECTED':
      return t.err.connection;
    case 'BUSY':
      return t.err.busy;
    case 'CHANGED':
      return t.err.changed;
    case 'NO_WIFI':
      return t.wifiOnly;
    case 'EXISTS':
      return t.err.exists;
    case 'CANCELLED':
      return t.stopped;
    case 'TRANSFER':
      return t.err.transfer;
    case 'NOT_ENCRYPTED':
      return t.err.notEncrypted;
    case 'PC_CHANGED':
      return t.err.pcChanged(/«\s*(.*?)\s*»/.exec(raw)?.[1] ?? '?');
    case 'SMB': {
      const status = /STATUS_[A-Z0-9_]+/.exec(raw)?.[0];
      if (status === 'STATUS_ACCESS_DENIED') return t.err.denied;
      if (status === 'STATUS_DISK_FULL') return t.err.diskFull;
      if (status === 'STATUS_LOGON_FAILURE') return t.err.auth;
      if (status === 'STATUS_BAD_NETWORK_NAME') return t.err.share;
      return t.err.refused(status ?? raw);
    }
    default:
      return raw || t.err.unknown;
  }
}
