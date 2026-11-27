// Les outils qui regardent ce qui est déjà sur le PC : doublons, vérification des copies, bilan
// du disque dur externe, carte des mois, et photos ramenées sur le téléphone.

import { connect } from './engine';
import { DISK_REPORT, parseDiskReport, type DiskReport } from './diskReport';
import { fromBase64, takenFromHead, thumbnailFromHead, toBase64, utf8 } from './exif';
import { forgetGallery, galleryMedia } from './gallery';
import {
  folderFor,
  joinPath,
  keepKind,
  monthOfFolder,
  quarantinePath,
  recommendKeep,
  retryOnce,
  yearMonthFromName,
  yearMonthOf,
  type DupReason,
  type Kinds,
  type Lang,
  type Sorting,
} from './logic';
import { t } from './i18n';
import { errorCode, errorMessage, Pg } from './native';
import { loadIndex, patchIndex, type CopyIndex, type PcSettings } from './store';

let stopRequested = false;

export function stopTools(): void {
  stopRequested = true;
  Pg.cancel();
}

function begin() {
  stopRequested = false;
  Pg.resetCancel();
}

/**
 * Une opération longue (relire tout le PC, ramener des vidéos) continue écran éteint, avec la
 * notification et son bouton Arrêter, comme une sauvegarde.
 */
export async function inBackground<T>(title: string, fn: () => Promise<T>): Promise<T> {
  Pg.startTransferService(title, t.tools.working, t.stop);
  const sub = Pg.addListener('onStopRequested', () => stopTools());
  Pg.holdWifi(true);
  try {
    return await fn();
  } finally {
    Pg.holdWifi(false);
    sub.remove();
    Pg.stopTransferService(title, '');
  }
}

const cancelled = () => Object.assign(new Error('Arrêté'), { code: 'CANCELLED' });

/** Une coupure en route : un nouvel essai, sur une connexion neuve. */
const again = <T>(op: () => Promise<T>) => retryOnce(op, (e) => errorCode(e) === 'CONNECTION' && !stopRequested);

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (!stopRequested) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

export type { DiskReport } from './diskReport';

export type PcFile = { path: string; name: string; size: number };

export type ToolProgress = { done: number; total: number; detail?: string };

const VIDEO_EXT = /\.(mp4|mov|m4v|3gp|3g2|mkv|webm|avi)$/i;
export const isVideo = (name: string) => VIDEO_EXT.test(name);

/** Ce que l'appli et la synchro laissent sur le PC et qui n'est pas une photo. */
const technical = (name: string) => /\.part$/i.test(name) || name.startsWith('.pixelguard');

/** Tout ce qu'il y a sous `root` (4 dossiers lus à la fois), sans « _Doublons » ni fichiers techniques. */
async function scanTree(root: string, onDetail: (d: string) => void): Promise<PcFile[]> {
  const files: PcFile[] = [];
  let queue = [root];
  let seen = 0;
  while (queue.length && !stopRequested) {
    const next: string[] = [];
    await pool(queue, 4, async (dir) => {
      const entries = await again(() => Pg.list(dir));
      for (const e of entries) {
        if (e.dir) {
          if (!/^_doublons$/i.test(e.name) && !e.name.startsWith('.')) next.push(joinPath(dir, e.name));
        } else if (!technical(e.name)) {
          files.push({ path: joinPath(dir, e.name), name: e.name, size: e.size });
        }
      }
      onDetail(String(++seen));
    });
    queue = next;
  }
  if (stopRequested) throw cancelled();
  return files;
}

/** Fichier absent : null sur Android, erreur NOT_FOUND sur iPhone. Les deux donnent null ici. */
async function orNull<T>(op: () => Promise<T | null>): Promise<T | null> {
  try {
    return await again(op);
  } catch (e) {
    if (errorCode(e) === 'NOT_FOUND') return null;
    throw e;
  }
}

const readRemote = (path: string, offset: number, length: number) => orNull(() => Pg.readRemote(path, offset, length));
const remoteMd5 = (path: string, size: number) => orNull(() => Pg.remoteMd5(path, size));

async function readHead(path: string, length = 128 * 1024): Promise<Uint8Array | null> {
  const b64 = await readRemote(path, 0, length);
  return b64 == null ? null : fromBase64(b64);
}

// ---------------------------------------------------------------- doublons

export type DupGroup = {
  md5: string;
  size: number;
  files: PcFile[];
  /** Le chemin recommandé, et pourquoi. */
  keep: string;
  reason: DupReason;
  /** Date de prise de vue lue dans le fichier, 0 si inconnue. */
  taken: number;
};

/**
 * Les fichiers identiques rangés à plusieurs endroits sous le dossier de ce téléphone. On ne relit
 * (MD5) que les fichiers qui ont la même taille qu'un autre : le reste ne peut pas être en double.
 */
export async function findDuplicates(opts: {
  pc: PcSettings;
  password: string;
  sorting: Sorting;
  lang: Lang;
  onProgress: (p: ToolProgress & { phase: 'list' | 'hash' }) => void;
}): Promise<DupGroup[]> {
  begin();
  const { pc } = opts;
  await connect(pc, opts.password);
  const files = await scanTree(pc.folder, (d) => opts.onProgress({ phase: 'list', done: Number(d), total: 0 }));
  const bySize = new Map<number, PcFile[]>();
  for (const f of files) {
    if (f.size <= 0) continue;
    const list = bySize.get(f.size);
    if (list) list.push(f);
    else bySize.set(f.size, [f]);
  }
  const candidates = [...bySize.values()].filter((l) => l.length > 1).flat();
  const total = candidates.reduce((n, f) => n + f.size, 0);
  let done = 0;
  const md5Of = new Map<string, string>();
  opts.onProgress({ phase: 'hash', done, total });
  await pool(candidates, 3, async (f) => {
    const md5 = await remoteMd5(f.path, f.size);
    if (md5 && !md5.includes(':')) md5Of.set(f.path, md5);
    done += f.size;
    opts.onProgress({ phase: 'hash', done, total, detail: f.name });
  });
  if (stopRequested) throw cancelled();

  const groups = new Map<string, PcFile[]>();
  for (const f of candidates) {
    const md5 = md5Of.get(f.path);
    if (!md5) continue;
    const key = `${md5}|${f.size}`;
    const list = groups.get(key);
    if (list) list.push(f);
    else groups.set(key, [f]);
  }
  const lang = pc.lang ?? opts.lang;
  const out: DupGroup[] = [];
  for (const [key, list] of groups) {
    if (list.length < 2) continue;
    // Les copies sont identiques : un seul début de fichier suffit pour la date.
    const head = await readHead(list[0].path).catch(() => null);
    const taken = (head && takenFromHead(head)) || 0;
    const fromName = list.map((f) => yearMonthFromName(f.name)).find(Boolean);
    let expected: string | null = null;
    if (taken || fromName) {
      const item = { name: list[0].name, taken, modified: taken, video: isVideo(list[0].name) };
      expected = joinPath(pc.folder, folderFor(item, opts.sorting, lang));
    }
    const { keep, reason } = recommendKeep(list, expected);
    out.push({ md5: key.split('|')[0], size: list[0].size, files: list, keep, reason, taken });
  }
  return out.sort((a, b) => b.size - a.size);
}

/**
 * Range les copies écartées dans « _Doublons » (même chemin relatif), sans rien effacer. Les
 * copies que l'index connaissait sous un chemin déplacé pointent ensuite sur celle gardée.
 */
export async function moveDuplicates(opts: {
  pc: PcSettings;
  password: string;
  choices: { group: DupGroup; keep: string }[];
  onProgress: (p: ToolProgress) => void;
}): Promise<{ moved: number; bytes: number; errors: string[] }> {
  begin();
  const { pc } = opts;
  await connect(pc, opts.password);
  const moves = opts.choices.flatMap(({ group, keep }) =>
    group.files.filter((f) => f.path !== keep).map((f) => ({ f, keep })),
  );
  const movedTo = new Map<string, string>();
  const errors: string[] = [];
  let moved = 0;
  let bytes = 0;
  for (const { f, keep } of moves) {
    if (stopRequested) break;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          await again(() => Pg.move(f.path, quarantinePath(pc.folder, f.path, attempt)));
          break;
        } catch (e) {
          if (errorCode(e) !== 'EXISTS' || attempt >= 20) throw e;
        }
      }
      movedTo.set(f.path.toLowerCase(), keep);
      moved++;
      bytes += f.size;
    } catch (e) {
      errors.push(`${f.name} : ${errorMessage(e)}`);
    }
    opts.onProgress({ done: moved + errors.length, total: moves.length, detail: f.name });
  }
  if (movedTo.size) {
    const index = await loadIndex(pc.id);
    const set: CopyIndex = {};
    for (const [id, entry] of Object.entries(index)) {
      const keep = movedTo.get(entry.path.toLowerCase());
      if (keep) set[id] = { ...entry, path: keep };
    }
    await patchIndex(pc.id, { set });
  }
  return { moved, bytes, errors };
}

// ---------------------------------------------------------------- vérification des copies

export type CheckResult = {
  checked: number;
  ok: number;
  /** Copies introuvables sur le PC. */
  missing: string[];
  /** Copies dont le contenu ne correspond plus à l'empreinte prise à l'envoi. */
  damaged: string[];
  /** Copies sans empreinte (envoyées avant la 0.4.0, ou trouvées sur le PC) : pas vérifiables ainsi. */
  noPrint: number;
  cancelled: boolean;
};

/** Relit chaque copie envoyée par l'appli et la compare au MD5 pris pendant l'envoi. */
export async function checkCopies(opts: {
  pc: PcSettings;
  password: string;
  onProgress: (p: ToolProgress) => void;
}): Promise<CheckResult> {
  begin();
  const { pc } = opts;
  await connect(pc, opts.password);
  const index = await loadIndex(pc.id);
  const all = Object.values(index);
  const withPrint = all.filter((e) => e.md5);
  const total = withPrint.reduce((n, e) => n + e.size, 0);
  const r: CheckResult = { checked: 0, ok: 0, missing: [], damaged: [], noPrint: all.length - withPrint.length, cancelled: false };
  let done = 0;
  opts.onProgress({ done, total });
  await pool(withPrint, 3, async (e) => {
    const name = e.path.slice(e.path.lastIndexOf('/') + 1);
    try {
      const md5 = await remoteMd5(e.path, e.size);
      if (md5 == null) r.missing.push(e.path);
      else if (md5 === e.md5) r.ok++;
      else r.damaged.push(e.path);
      r.checked++;
    } catch (err) {
      if (errorCode(err) !== 'CANCELLED') r.damaged.push(`${e.path} : ${errorMessage(err)}`);
    }
    done += e.size;
    opts.onProgress({ done, total, detail: name });
  });
  r.cancelled = stopRequested;
  return r;
}

// ---------------------------------------------------------------- disque dur externe

let lastReport: { pcId: string; at: number; report: DiskReport | null } | null = null;

/** Le bilan du disque dur, ou null si la synchro n'est pas réglée sur ce PC (gardé 1 min). */
export async function readDiskReport(pc: PcSettings, password: string): Promise<DiskReport | null> {
  if (lastReport && lastReport.pcId === pc.id && Date.now() - lastReport.at < 60_000) return lastReport.report;
  await connect(pc, password);
  const b64 = await readRemote(DISK_REPORT, 0, 1 << 20);
  const report = b64 ? parseDiskReport(utf8(fromBase64(b64))) : null;
  lastReport = { pcId: pc.id, at: Date.now(), report };
  return report;
}

/** Photos envoyées sur le PC depuis la dernière copie sur le disque, d'après l'historique. */
export function sentSince(report: DiskReport, runs: { at: number; uploaded: number }[]): number {
  const since = Date.parse(report.lastSync);
  if (!since) return 0;
  return runs.filter((r) => r.at > since).reduce((n, r) => n + r.uploaded, 0);
}

// ---------------------------------------------------------------- carte des mois

export type MonthRow = {
  /** 202611 */
  key: number;
  phone: number;
  /** Sur le téléphone et déjà sur le PC (d'après les sauvegardes passées). */
  saved: number;
  /** Fichiers dans le dossier du mois sur le PC et sur le disque (bilan du disque), null si inconnu. */
  pc: number | null;
  disk: number | null;
};

/** Fichiers par mois sous `root`, d'après les comptes par dossier du bilan. */
function countByMonth(folders: Record<string, number>, root: string): Map<number, number> {
  const out = new Map<number, number>();
  const prefix = root ? root.toLowerCase() + '/' : '';
  for (const [dir, n] of Object.entries(folders)) {
    const rel = dir.replace(/\\/g, '/');
    if (prefix && !rel.toLowerCase().startsWith(prefix)) continue;
    const k = monthOfFolder(rel.slice(prefix.length));
    if (k) out.set(k, (out.get(k) ?? 0) + n);
  }
  return out;
}

export async function monthsMap(opts: {
  pc: PcSettings;
  albumIds: string[];
  kinds: Kinds;
  report: DiskReport | null;
}): Promise<MonthRow[]> {
  const [all, index] = await Promise.all([galleryMedia(opts.albumIds), loadIndex(opts.pc.id)]);
  const rows = new Map<number, MonthRow>();
  const row = (k: number) => {
    let r = rows.get(k);
    if (!r) {
      r = { key: k, phone: 0, saved: 0, pc: opts.report ? 0 : null, disk: opts.report ? 0 : null };
      rows.set(k, r);
    }
    return r;
  };
  for (const m of all) {
    if (!keepKind(m, opts.kinds)) continue;
    const [y, mo] = yearMonthOf(m);
    const r = row(y * 100 + mo);
    r.phone++;
    const k = index[m.id];
    if (k && k.size === m.size) r.saved++;
  }
  if (opts.report) {
    for (const [k, n] of countByMonth(opts.report.pcFolders, opts.pc.folder)) row(k).pc = n;
    for (const [k, n] of countByMonth(opts.report.diskFolders, opts.pc.folder)) row(k).disk = n;
  }
  return [...rows.values()].sort((a, b) => b.key - a.key);
}

// ---------------------------------------------------------------- ramener sur le téléphone

export type PcDir = { dirs: string[]; files: PcFile[] };

export async function listPcDir(pc: PcSettings, password: string, dir: string): Promise<PcDir> {
  begin();
  await connect(pc, password);
  const entries = await again(() => Pg.list(dir));
  const dirs = entries
    .filter((e) => e.dir && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => (monthOfFolder(b) ?? 0) - (monthOfFolder(a) ?? 0) || a.localeCompare(b));
  const files = entries
    .filter((e) => !e.dir && !technical(e.name))
    .map((e) => ({ path: joinPath(dir, e.name), name: e.name, size: e.size }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { dirs, files };
}

const thumbs = new Map<string, string | null>();

/** La vignette rangée dans l'EXIF d'une photo du PC, en data URI (64 Ko lus), ou null. */
export async function pcThumbnail(path: string): Promise<string | null> {
  if (thumbs.has(path)) return thumbs.get(path) ?? null;
  let uri: string | null = null;
  if (/\.(jpe?g)$/i.test(path)) {
    const head = await readHead(path, 64 * 1024).catch(() => null);
    const thumb = head ? thumbnailFromHead(head) : null;
    uri = thumb ? `data:image/jpeg;base64,${toBase64(thumb)}` : null;
  }
  thumbs.set(path, uri);
  return uri;
}

/** Ramène des fichiers du PC dans la galerie du téléphone, un par un. */
export async function restoreToPhone(opts: {
  pc: PcSettings;
  password: string;
  files: PcFile[];
  onProgress: (p: ToolProgress) => void;
}): Promise<{ done: number; errors: string[]; cancelled: boolean }> {
  begin();
  await connect(opts.pc, opts.password);
  const total = opts.files.reduce((n, f) => n + f.size, 0);
  let base = 0;
  let done = 0;
  const errors: string[] = [];
  const sub = Pg.addListener('onProgress', (e) => {
    if (e.id === 'restore') opts.onProgress({ done: base + e.bytes, total });
  });
  try {
    for (const f of opts.files) {
      if (stopRequested) break;
      opts.onProgress({ done: base, total, detail: f.name });
      try {
        await again(() => Pg.download(f.path, f.size, f.name, isVideo(f.name), 'restore'));
        done++;
      } catch (e) {
        if (errorCode(e) === 'CANCELLED') break;
        errors.push(`${f.name} : ${errorMessage(e)}`);
      }
      base += f.size;
    }
  } finally {
    sub.remove();
    // Les photos ramenées sont de nouveaux médias : la galerie sera relue.
    forgetGallery();
  }
  return { done, errors, cancelled: stopRequested };
}
