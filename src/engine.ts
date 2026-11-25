import {
  decide,
  folderState,
  humanBytes,
  joinPath,
  inPeriod,
  keepKind,
  monthsOf,
  plan,
  sanitizeSegment,
  variantKey as variantKeyOf,
  targetFolders,
  type FolderState,
  type Kinds,
  type Lang,
  type MonthCount,
  type PlanEntry,
  type Period,
  type Sorting,
} from './logic';
import { t } from './i18n';
import { errorCode, errorMessage, Pg, type MediaItem } from './native';
import { loadIndex, saveIndex, type CopyIndex, type PcSettings } from './store';

export type Phase = 'connect' | 'scan' | 'compare' | 'send' | 'verify' | 'done';

export type Live = { id: string; name: string; uri: string; size: number; bytes: number };

export type Progress = {
  phase: Phase;
  totalFiles: number;
  doneFiles: number;
  totalBytes: number;
  doneBytes: number;
  /** Octets par seconde, sur ce qui est vraiment passé sur le réseau (moyenne glissante). */
  speed: number;
  /** Secondes restantes. */
  eta: number;
  live: Live[];
  uploaded: number;
  skipped: number;
  failed: number;
  detail?: string;
};

export type BackupResult = {
  uploaded: number;
  skipped: number;
  failed: number;
  cancelled: boolean;
  bytes: number;
  seconds: number;
  errors: string[];
  encrypted: boolean;
};

/** Fichiers envoyés en même temps : les petites photos s'enchaînent sans temps mort. */
const PARALLEL = 3;

const emptyProgress = (phase: Phase): Progress => ({
  phase, totalFiles: 0, doneFiles: 0, totalBytes: 0, doneBytes: 0, speed: 0, eta: 0,
  live: [], uploaded: 0, skipped: 0, failed: 0,
});

let stopRequested = false;

export function stop(): void {
  stopRequested = true;
  Pg.cancel();
}

function connect(pc: PcSettings, password: string) {
  return Pg.connect({ host: pc.host, share: pc.share, user: pc.user, password, encrypt: pc.encrypt });
}

const dirOf = (path: string) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** Identité d'un original : un « .part » n'est repris que s'il vient du même fichier. */
const sourceKey = (m: MediaItem) => `${m.uri}|${m.size}|${m.modified}`;

/** Fait tourner `fn` sur chaque élément, `n` à la fois. */
async function pool<T>(items: T[], n: number, fn: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (!stopRequested) {
      const i = next++;
      if (i >= items.length) return;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
}

/** Vitesse sur les 5 dernières secondes, plus parlante qu'une moyenne depuis le début. */
function speedMeter() {
  const samples: [number, number][] = [];
  return (total: number) => {
    const now = Date.now();
    samples.push([now, total]);
    while (samples.length > 2 && now - samples[0][0] > 5000) samples.shift();
    const [t0, b0] = samples[0];
    return now > t0 ? ((total - b0) * 1000) / (now - t0) : 0;
  };
}

export type Stats = {
  total: number;
  totalBytes: number;
  saved: number;
  savedBytes: number;
  pending: MediaItem[];
  pendingBytes: number;
  /** Les plus récents : une photo et une vidéo, pour montrer le rangement. */
  samples: MediaItem[];
  /** Les mois présents dans les albums choisis (avant le filtre de période). */
  months: MonthCount[];
};

async function sourceItems(albumIds: string[], kinds: Kinds): Promise<MediaItem[]> {
  return (await Pg.listMedia(albumIds)).filter((m) => keepKind(m, kinds));
}

/** Ce qui est déjà sur le PC d'après les sauvegardes passées, sans toucher au réseau. */
export async function stats(albumIds: string[], kinds: Kinds, period: Period, pcId: string): Promise<Stats> {
  const [all, index] = await Promise.all([sourceItems(albumIds, kinds), loadIndex(pcId)]);
  const months = monthsOf(all);
  const items = all.filter((m) => inPeriod(m, period));
  const photo = items.find((m) => !m.video);
  const video = items.find((m) => m.video);
  const samples = [photo, video].filter((m): m is MediaItem => !!m);
  const s: Stats = { total: items.length, totalBytes: 0, saved: 0, savedBytes: 0, pending: [], pendingBytes: 0, samples, months };
  for (const m of items) {
    s.totalBytes += m.size;
    const known = index[m.id];
    if (known && known.size === m.size) {
      s.saved++;
      s.savedBytes += m.size;
    } else {
      s.pending.push(m);
      s.pendingBytes += m.size;
    }
  }
  return s;
}

export type Comparison = {
  index: CopyIndex;
  entries: PlanEntry<MediaItem>[];
  /** À envoyer, avec le nom qu'ils auront sur le PC. */
  uploads: PlanEntry<MediaItem>[];
  /** Déjà sur le PC (même nom, même taille). */
  already: number;
  alreadyBytes: number;
  /** À envoyer sous « nom (1) » : un autre fichier porte déjà ce nom sur le PC. */
  renamed: number;
  /** Fichiers des dossiers visés qui ne viennent pas de ce téléphone (autre appareil, copie à la main). */
  extraOnPc: number;
  folders: string[];
};

type Selection = {
  pc: PcSettings;
  albumIds: string[];
  kinds: Kinds;
  period: Period;
  sorting: Sorting;
  lang: Lang;
  /** Médias retirés à la main de cet envoi. */
  exclude?: Set<string>;
};

/**
 * Ce que le PC a déjà et ce qui manque, sans rien envoyer. Lit chaque dossier visé (4 à la fois),
 * plus ceux où l'index dit avoir déjà copié un fichier : si le rangement a changé, on ne recopie
 * pas ce qui est déjà sur le PC.
 */
async function compareWithPc(opts: Selection, onDetail: (d: string) => void): Promise<Comparison> {
  const { pc, lang } = opts;
  const items = (await sourceItems(opts.albumIds, opts.kinds)).filter(
    (m) => inPeriod(m, opts.period) && !opts.exclude?.has(m.id),
  );
  const index: CopyIndex = await loadIndex(pc.id);

  const targets = targetFolders(items, opts.sorting, lang);
  const dirs = new Set(targets.map((f) => joinPath(pc.folder, f)));
  for (const m of items) {
    const k = index[m.id];
    if (k && k.size === m.size) dirs.add(dirOf(k.path));
  }
  const states = new Map<string, FolderState>();
  const all = [...dirs];
  let listed = 0;
  await pool(all, 4, async (d) => {
    const entries = await Pg.list(d);
    states.set(d, folderState(entries.filter((e) => !e.dir)));
    onDetail(`${++listed} / ${all.length}`);
  });
  const before = new Map<string, number>();
  for (const f of targets) before.set(joinPath(pc.folder, f), states.get(joinPath(pc.folder, f))?.names.size ?? 0);

  const matched = new Map<string, Set<string>>();
  const match = (path: string) => {
    const d = dirOf(path);
    if (!before.has(d)) return;
    const set = matched.get(d) ?? new Set<string>();
    set.add(baseOf(path).toLowerCase());
    matched.set(d, set);
  };

  let already = 0;
  let alreadyBytes = 0;
  const fresh: MediaItem[] = [];
  for (const m of items) {
    const k = index[m.id];
    if (k && k.size === m.size) {
      const name = baseOf(k.path).toLowerCase();
      const st = states.get(dirOf(k.path));
      if (st?.byKey.get(variantKeyOf(name))?.some((f) => f.name.toLowerCase() === name && f.size === m.size)) {
        already++;
        alreadyBytes += m.size;
        match(k.path);
        continue;
      }
    }
    fresh.push(m);
  }

  const folders = new Map<string, FolderState>();
  for (const f of targets) folders.set(f, states.get(joinPath(pc.folder, f)) ?? folderState([]));
  const entries = plan(fresh, folders, opts.sorting, lang);
  const uploads: PlanEntry<MediaItem>[] = [];
  let renamed = 0;
  for (const e of entries) {
    const path = joinPath(pc.folder, e.folder, e.remoteName);
    if (e.action === 'skip') {
      index[e.item.id] = { path, size: e.item.size };
      already++;
      alreadyBytes += e.item.size;
      match(path);
    } else {
      uploads.push(e);
      if (e.remoteName.toLowerCase() !== sanitizeSegment(e.item.name).toLowerCase()) renamed++;
    }
  }
  let extraOnPc = 0;
  before.forEach((count, d) => {
    extraOnPc += Math.max(0, count - (matched.get(d)?.size ?? 0));
  });
  return { index, entries, uploads, already, alreadyBytes, renamed, extraOnPc, folders: targets };
}

export type Preview = Omit<Comparison, 'index' | 'entries' | 'uploads'> & {
  missing: MediaItem[];
  missingBytes: number;
  total: number;
  encrypted: boolean;
};

/** La comparaison seule, pour l'accueil : « 120 déjà sur le PC, il manque ces 30 ». */
export async function preview(opts: Selection & { password: string }): Promise<Preview> {
  stopRequested = false; // un « Arrêter » d'avant ne doit pas couper la comparaison
  Pg.resetCancel();
  const info = await connect(opts.pc, opts.password);
  const cmp = await compareWithPc(opts, () => {});
  await saveIndex(opts.pc.id, cmp.index); // ce qu'on a vu sur le PC sert aussi à l'anneau
  const missing = cmp.uploads.map((e) => e.item);
  const { index: _i, entries: _e, uploads: _u, ...rest } = cmp;
  return {
    ...rest,
    missing,
    missingBytes: missing.reduce((n, m) => n + m.size, 0),
    total: cmp.already + missing.length,
    encrypted: info.encrypted,
  };
}

export async function runBackup(
  opts: Selection & { password: string; onProgress: (p: Progress) => void },
): Promise<BackupResult> {
  const { pc, lang, onProgress } = opts;
  stopRequested = false;
  Pg.resetCancel();
  const started = Date.now();
  const p = emptyProgress('connect');
  const errors: string[] = [];
  onProgress({ ...p });

  const info = await connect(pc, opts.password);
  Pg.holdWifi(true);
  // Service de premier plan : la sauvegarde continue écran éteint, avec sa notification.
  Pg.startTransferService(t.notifTitle, t.phase.compare, t.stop);
  const stopSub = Pg.addListener('onStopRequested', () => stop());
  let lastNotif = 0;
  const notify = (force = false) => {
    const now = Date.now();
    if (!force && now - lastNotif < 1000) return;
    lastNotif = now;
    Pg.updateTransferService(
      t.notifProgress(p.doneFiles, p.totalFiles, humanBytes(p.speed, lang)),
      p.totalBytes ? Math.round((p.doneBytes / p.totalBytes) * 1000) : 0,
      1000,
    );
  };
  let finalText = '';
  try {
    p.phase = 'scan';
    onProgress({ ...p });
    const cmp = await compareWithPc(opts, (detail) => onProgress({ ...p, phase: 'compare', detail }));
    const { index, entries } = cmp;
    const uploads = cmp.uploads;
    p.skipped = cmp.already;
    p.totalFiles = uploads.length;
    p.totalBytes = uploads.reduce((s, e) => s + e.item.size, 0);
    p.phase = 'send';
    p.detail = undefined;
    onProgress({ ...p });

    await pool([...new Set(uploads.map((e) => e.folder))], 4, async (f) => {
      await Pg.mkdirs(joinPath(pc.folder, f));
    });

    const live = new Map<string, Live>();
    let finishedBytes = 0; // fichiers terminés (envoyés ou pas)
    let networkBytes = 0; // fichiers vraiment envoyés
    const meter = speedMeter();
    let lastEmit = 0;
    const emit = (force = false) => {
      const now = Date.now();
      if (!force && now - lastEmit < 250) return;
      lastEmit = now;
      let inFlight = 0;
      live.forEach((v) => (inFlight += v.bytes));
      p.doneBytes = finishedBytes + inFlight;
      p.speed = meter(networkBytes + inFlight);
      p.eta = p.speed > 1024 ? (p.totalBytes - p.doneBytes) / p.speed : 0;
      p.live = [...live.values()].map((v) => ({ ...v }));
      onProgress({ ...p });
      notify();
    };
    const sub = Pg.addListener('onProgress', (ev) => {
      const t = live.get(ev.id);
      if (t) {
        t.bytes = ev.bytes;
        emit();
      }
    });

    let cancelled = false;
    let sinceSave = 0;
    try {
      await pool(uploads, PARALLEL, async (e, i) => {
        const id = String(i);
        live.set(id, { id, name: e.item.name, uri: e.item.uri, size: e.item.size, bytes: 0 });
        emit(true);
        try {
          let target = joinPath(pc.folder, e.folder, e.remoteName);
          try {
            await Pg.upload(e.item.uri, target, e.item.size, id, sourceKey(e.item));
          } catch (err) {
            if (errorCode(err) !== 'EXISTS') throw err;
            // Le dossier a changé depuis le listing (PixelGuard en USB, autre téléphone...).
            const fresh = folderState((await Pg.list(joinPath(pc.folder, e.folder))).filter((x) => !x.dir));
            const d = decide(e.item.name, e.item.size, fresh);
            target = joinPath(pc.folder, e.folder, d.remoteName);
            if (d.action === 'skip') {
              p.skipped++;
              index[e.item.id] = { path: target, size: e.item.size };
              return;
            }
            await Pg.upload(e.item.uri, target, e.item.size, id, sourceKey(e.item));
          }
          p.uploaded++;
          networkBytes += e.item.size;
          index[e.item.id] = { path: target, size: e.item.size };
          if (++sinceSave >= 25) {
            sinceSave = 0;
            await saveIndex(pc.id, index);
          }
        } catch (err) {
          if (errorCode(err) === 'CANCELLED' || stopRequested) {
            cancelled = true;
          } else {
            p.failed++;
            errors.push(`${e.item.name} : ${errorMessage(err)}`);
          }
        } finally {
          live.delete(id);
          finishedBytes += e.item.size;
          p.doneFiles++;
          emit(true);
        }
      });
    } finally {
      sub.remove();
      await saveIndex(pc.id, index);
    }

    cancelled = cancelled || stopRequested;
    p.phase = 'done';
    p.live = [];
    onProgress({ ...p });
    finalText = cancelled ? t.stopped : t.result(p.uploaded, p.skipped, p.failed);
    return {
      uploaded: p.uploaded,
      skipped: p.skipped,
      failed: p.failed,
      cancelled,
      bytes: networkBytes,
      seconds: (Date.now() - started) / 1000,
      errors,
      encrypted: info.encrypted,
    };
  } finally {
    Pg.holdWifi(false);
    stopSub.remove();
    Pg.stopTransferService(t.notifTitle, finalText);
  }
}

// ---------------------------------------------------------------- Libérer de la place

export type FreeCandidate = { item: MediaItem; path: string };

export function dateOf(m: MediaItem): number {
  return m.taken > 0 ? m.taken : m.modified;
}

/** Ce qui est sur le PC d'après les sauvegardes passées, plus vieux que `olderThanDays`. */
export async function findFreeCandidates(pcId: string, albumIds: string[], kinds: Kinds, olderThanDays: number): Promise<FreeCandidate[]> {
  const [items, index] = await Promise.all([sourceItems(albumIds, kinds), loadIndex(pcId)]);
  const cutoff = Date.now() - olderThanDays * 86400e3;
  return items
    .filter((m) => index[m.id] && index[m.id].size === m.size && dateOf(m) < cutoff)
    .map((m) => ({ item: m, path: index[m.id].path }));
}

/** Relit chaque copie sur le PC et la compare octet par octet (MD5) à l'original. */
export async function verifyCandidates(opts: {
  pc: PcSettings;
  password: string;
  candidates: FreeCandidate[];
  onProgress: (p: Progress) => void;
}): Promise<{ same: FreeCandidate[]; different: string[]; cancelled: boolean }> {
  stopRequested = false;
  Pg.resetCancel();
  await connect(opts.pc, opts.password);
  Pg.holdWifi(true);
  const p = emptyProgress('verify');
  p.totalFiles = opts.candidates.length;
  p.totalBytes = opts.candidates.reduce((s, c) => s + c.item.size, 0);
  const meter = speedMeter();
  const same: FreeCandidate[] = [];
  const different: string[] = [];
  opts.onProgress({ ...p });
  try {
    await pool(opts.candidates, PARALLEL, async (c) => {
      try {
        const r = await Pg.verify(c.item.uri, c.path, c.item.size);
        if (r.same) same.push(c);
        else different.push(c.item.name);
      } catch (err) {
        if (errorCode(err) !== 'CANCELLED') different.push(`${c.item.name} : ${errorMessage(err)}`);
      }
      p.doneFiles++;
      p.doneBytes += c.item.size;
      p.speed = meter(p.doneBytes);
      p.eta = p.speed > 1024 ? (p.totalBytes - p.doneBytes) / p.speed : 0;
      p.live = [{ id: c.item.id, name: c.item.name, uri: c.item.uri, size: c.item.size, bytes: c.item.size }];
      opts.onProgress({ ...p });
    });
  } finally {
    Pg.holdWifi(false);
  }
  return { same, different, cancelled: stopRequested };
}

/** Android affiche lui-même la confirmation, puis met à la corbeille (30 jours). */
export async function moveToTrash(pcId: string, verified: FreeCandidate[]): Promise<boolean> {
  const ok = await Pg.removeFromPhone(verified.map((c) => c.item.uri), true);
  if (ok) {
    const index = await loadIndex(pcId);
    for (const c of verified) delete index[c.item.id];
    await saveIndex(pcId, index);
  }
  return ok;
}

export async function speedTest(pc: PcSettings, password: string, onBytes: (b: number) => void) {
  await connect(pc, password);
  const sub = Pg.addListener('onProgress', (e) => {
    if (e.id === 'speed') onBytes(e.bytes);
  });
  try {
    return await Pg.speedTest(pc.folder, 128);
  } finally {
    sub.remove();
  }
}
