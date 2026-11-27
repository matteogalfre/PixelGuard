import {
  addToFolder,
  canRelocate,
  movedTo,
  decide,
  folderFor,
  folderState,
  humanBytes,
  joinPath,
  inPeriod,
  keepKind,
  monthsOf,
  plan,
  retryOnce,
  sanitizeSegment,
  variantKey as variantKeyOf,
  targetFolders,
  type FolderState,
  type Kinds,
  type Lang,
  type MonthCount,
  type PlanEntry,
  type Pairing,
  type Period,
  type Sorting,
} from './logic';
import { galleryMedia } from './gallery';
import { lang as phoneLang, t } from './i18n';
import { errorCode, errorMessage, Pg, type LoginInfo, type MediaItem } from './native';
import { emptySettings, loadIndex, patchIndex, rememberIdentity, type CopyIndex, type PcSettings } from './store';

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

/**
 * Tailles lues fichier par fichier, par lots : sur une grosse galerie ça fait des milliers
 * d'allers-retours, donc l'avancement s'affiche et Arrêter est pris en compte entre deux lots.
 */
async function statInBatches(paths: string[], onDetail: (d: string) => void): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < paths.length; i += 200) {
    if (stopRequested) throw Object.assign(new Error(t.stopped), { code: 'CANCELLED' });
    out.push(...(await again(() => Pg.statFiles(paths.slice(i, i + 200)))));
    if (paths.length > 200) onDetail(t.checkingOne(Math.min(i + 200, paths.length), paths.length));
  }
  return out;
}

/** Une coupure en route : un nouvel essai, sur une connexion neuve (sauf si on a demandé l'arrêt). */
const again = <T>(op: () => Promise<T>) => retryOnce(op, (e) => errorCode(e) === 'CONNECTION' && !stopRequested);

let identityListener: ((pcId: string, identity: string) => void) | null = null;

/** Prévenu quand un PC enregistré avant le contrôle du nom vient d'être identifié. */
export function onPcIdentified(fn: ((pcId: string, identity: string) => void) | null): void {
  identityListener = fn;
}

export async function connect(pc: PcSettings, password: string) {
  const info = await Pg.connect({
    host: pc.host, share: pc.share, user: pc.user, password, encrypt: pc.encrypt, identity: pc.identity ?? '',
  });
  if (pc.id && !pc.identity && info.identity) {
    await rememberIdentity(pc.id, info.identity);
    identityListener?.(pc.id, info.identity);
  }
  return info;
}

/** Ajoute (ou corrige) un fichier dans l'état d'un dossier. */
function upsertRemote(st: FolderState, f: { name: string; size: number }) {
  const existing = st.byKey.get(variantKeyOf(f.name))?.find((x) => x.name.toLowerCase() === f.name.toLowerCase());
  if (existing) existing.size = f.size;
  else addToFolder(st, f);
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
  return (await galleryMedia(albumIds)).filter((m) => keepKind(m, kinds));
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
  /** Ce que la comparaison a trouvé sur le PC et que l'index ne savait pas encore. */
  found: CopyIndex;
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
  /** Fichiers que la liste du PC montrait mal (absents ou taille périmée), vérifiés un par un. */
  checkedOneByOne: number;
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
  const { pc } = opts;
  // Les noms de dossiers suivent la langue fixée pour ce PC, pas celle du téléphone.
  const lang = pc.lang ?? opts.lang;
  const found: CopyIndex = {};
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
    const entries = await again(() => Pg.list(d));
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
  let checkedOneByOne = 0;
  const fresh: MediaItem[] = [];
  const doubtful: { m: MediaItem; path: string }[] = [];
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
      // Envoyé d'après l'index, mais absent de la liste : on demande au fichier lui-même.
      doubtful.push({ m, path: k.path });
      continue;
    }
    fresh.push(m);
  }
  if (doubtful.length) {
    const sizes = await statInBatches(doubtful.map((d) => d.path), onDetail);
    doubtful.forEach(({ m, path }, i) => {
      if (sizes[i] === m.size) {
        already++;
        alreadyBytes += m.size;
        checkedOneByOne++;
        match(path);
        const st = states.get(dirOf(path));
        if (st) upsertRemote(st, { name: baseOf(path), size: m.size });
      } else {
        fresh.push(m);
      }
    });
  }
  // Même nom mais autre taille dans la liste : Windows a pu y laisser une taille périmée.
  // On relit la vraie taille avant de conclure à un autre fichier (et de l'envoyer en « nom (1) »).
  const recheck: { f: { name: string; size: number }; path: string }[] = [];
  for (const m of fresh) {
    const f = folderFor(m, opts.sorting, lang);
    const same = states.get(joinPath(pc.folder, f))?.byKey.get(variantKeyOf(sanitizeSegment(m.name)));
    if (same && !same.some((x) => x.size === m.size)) {
      for (const x of same) recheck.push({ f: x, path: joinPath(pc.folder, f, x.name) });
    }
  }
  if (recheck.length) {
    const sizes = await statInBatches(recheck.map((r) => r.path), onDetail);
    recheck.forEach((r, i) => {
      if (sizes[i] >= 0 && sizes[i] !== r.f.size) {
        r.f.size = sizes[i];
        checkedOneByOne++;
      }
    });
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
      found[e.item.id] = { path, size: e.item.size };
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
  return { index, found, entries, uploads, already, alreadyBytes, renamed, extraOnPc, checkedOneByOne, folders: targets };
}

export type Preview = Omit<Comparison, 'index' | 'found' | 'entries' | 'uploads'> & {
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
  await patchIndex(opts.pc.id, { set: cmp.found }); // ce qu'on a vu sur le PC sert aussi à l'anneau
  const missing = cmp.uploads.map((e) => e.item);
  const { index: _i, found: _f, entries: _e, uploads: _u, ...rest } = cmp;
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

  // Service de premier plan dès le départ : écran éteint, même la connexion et la comparaison
  // continuent, avec la notification et son bouton Arrêter.
  Pg.startTransferService(t.notifTitle, t.phase.connect, t.stop);
  let stopReason = '';
  const stopSub = Pg.addListener('onStopRequested', (e) => {
    stopReason = e?.reason ?? '';
    stop();
  });
  Pg.holdWifi(true);
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
    const info = await connect(pc, opts.password);
    p.phase = 'scan';
    onProgress({ ...p });
    const cmp = await compareWithPc(opts, (detail) => onProgress({ ...p, phase: 'compare', detail }));
    const { index } = cmp;
    const uploads = cmp.uploads;
    // Ce qu'on apprend pendant l'envoi, enregistré par petits lots sur la dernière version.
    let pending: CopyIndex = { ...cmp.found };
    // `md5` et `mod` : seulement pour un fichier que cette sauvegarde vient d'envoyer.
    const remember = (id: string, path: string, size: number, md5?: string, mod?: number) => {
      const entry = md5 ? { path, size, md5, mod } : { path, size };
      index[id] = entry;
      pending[id] = entry;
    };
    const flush = async () => {
      const batch = pending;
      pending = {};
      await patchIndex(pc.id, { set: batch });
    };
    // Les noms que les envois de cette sauvegarde vont prendre, par dossier : un fichier qui doit
    // changer de nom en route n'en prend jamais un déjà promis à un autre.
    const reserved = new Map<string, Set<string>>();
    const reserve = (folder: string, name: string) => {
      const set = reserved.get(folder) ?? new Set<string>();
      set.add(name.toLowerCase());
      reserved.set(folder, set);
    };
    for (const u of uploads) reserve(u.folder, u.remoteName);
    p.skipped = cmp.already;
    p.totalFiles = uploads.length;
    p.totalBytes = uploads.reduce((s, e) => s + e.item.size, 0);
    p.phase = 'send';
    p.detail = undefined;
    onProgress({ ...p });

    await pool([...new Set(uploads.map((e) => e.folder))], 4, async (f) => {
      await again(() => Pg.mkdirs(joinPath(pc.folder, f)));
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
    let lastSave = Date.now();
    try {
      await pool(uploads, PARALLEL, async (e, i) => {
        const id = String(i);
        live.set(id, { id, name: e.item.name, uri: e.item.uri, size: e.item.size, bytes: 0 });
        // Pas d'affichage forcé par fichier : avec des centaines de petites photos par seconde,
        // l'écran se redessinerait sans arrêt. Quatre fois par seconde suffisent.
        emit();
        try {
          let target = joinPath(pc.folder, e.folder, e.remoteName);
          let sent: { md5?: string };
          try {
            sent = await again(() => Pg.upload(e.item.uri, target, e.item.size, id, sourceKey(e.item)));
          } catch (err) {
            if (errorCode(err) !== 'EXISTS') throw err;
            // Ce nom est déjà pris sur le PC : si c'est ce fichier (même taille, lue sur le
            // fichier lui-même), il est déjà là. Sinon on relit le dossier pour un nom libre.
            const [onPc] = await again(() => Pg.statFiles([target]));
            if (onPc === e.item.size) {
              p.skipped++;
              remember(e.item.id, target, e.item.size);
              return;
            }
            const fresh = folderState((await again(() => Pg.list(joinPath(pc.folder, e.folder)))).filter((x) => !x.dir));
            upsertRemote(fresh, { name: e.remoteName, size: onPc });
            for (const name of reserved.get(e.folder) ?? []) {
              // taille impossible : un nom promis n'est jamais pris pour « déjà là »
              if (!fresh.names.has(name)) addToFolder(fresh, { name, size: -2 });
            }
            const d = decide(e.item.name, e.item.size, fresh);
            target = joinPath(pc.folder, e.folder, d.remoteName);
            if (d.action === 'skip') {
              p.skipped++;
              remember(e.item.id, target, e.item.size);
              return;
            }
            reserve(e.folder, d.remoteName);
            sent = await again(() => Pg.upload(e.item.uri, target, e.item.size, id, sourceKey(e.item)));
          }
          p.uploaded++;
          networkBytes += e.item.size;
          remember(e.item.id, target, e.item.size, sent.md5 || undefined, e.item.modified);
          // Écrit de temps en temps (une coupure ne fait perdre que ça), sans faire attendre
          // l'envoi suivant : l'index d'une grosse galerie pèse plusieurs Mo.
          if (++sinceSave >= 200 || Date.now() - lastSave > 20_000) {
            sinceSave = 0;
            lastSave = Date.now();
            flush().catch(() => {});
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
          emit();
        }
      });
    } finally {
      sub.remove();
      await flush();
    }
    emit(true); // les derniers chiffres, exacts

    cancelled = cancelled || stopRequested;
    p.phase = 'done';
    p.live = [];
    onProgress({ ...p });
    const limit = stopReason === 'timeout' ? t.stoppedTimeout : stopReason === 'background' ? t.stoppedBackground : '';
    if (limit) errors.unshift(limit);
    finalText = cancelled ? limit || t.stopped : t.result(p.uploaded, p.skipped, p.failed);
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

/** `md5` : l'empreinte prise à l'envoi, si l'original n'a pas changé depuis. */
export type FreeCandidate = { item: MediaItem; path: string; md5?: string };

export function dateOf(m: MediaItem): number {
  return m.taken > 0 ? m.taken : m.modified;
}

/** Ce qui est sur le PC d'après les sauvegardes passées, plus vieux que `olderThanDays`. */
export async function findFreeCandidates(pcId: string, albumIds: string[], kinds: Kinds, olderThanDays: number): Promise<FreeCandidate[]> {
  const [items, index] = await Promise.all([sourceItems(albumIds, kinds), loadIndex(pcId)]);
  const cutoff = Date.now() - olderThanDays * 86400e3;
  return items
    .filter((m) => index[m.id] && index[m.id].size === m.size && dateOf(m) < cutoff)
    .map((m) => {
      const k = index[m.id];
      // Original retouché depuis l'envoi (autre date) : on relit les deux, comme avant.
      const md5 = k.md5 && k.mod === m.modified ? k.md5 : undefined;
      return { item: m, path: k.path, md5 };
    });
}

/**
 * Relit chaque copie sur le PC et la compare (MD5) à l'original : à l'empreinte prise pendant
 * l'envoi quand l'original n'a pas changé depuis, sinon à l'original relu sur le téléphone.
 */
export async function verifyCandidates(opts: {
  pc: PcSettings;
  password: string;
  candidates: FreeCandidate[];
  onProgress: (p: Progress) => void;
}): Promise<{ same: FreeCandidate[]; different: string[]; cancelled: boolean }> {
  stopRequested = false;
  Pg.resetCancel();
  // Relire des Go de vidéos prend du temps : elle aussi continue écran éteint.
  Pg.startTransferService(t.notifVerifyTitle, t.phase.connect, t.stop);
  const stopSub = Pg.addListener('onStopRequested', () => stop());
  Pg.holdWifi(true);
  let finalText = '';
  const p = emptyProgress('verify');
  p.totalFiles = opts.candidates.length;
  p.totalBytes = opts.candidates.reduce((s, c) => s + c.item.size, 0);
  const meter = speedMeter();
  const same: FreeCandidate[] = [];
  const different: string[] = [];
  opts.onProgress({ ...p });
  let lastNotif = 0;
  let lastShown = 0;
  try {
    await connect(opts.pc, opts.password);
    await pool(opts.candidates, PARALLEL, async (c) => {
      try {
        const r = await again(() => Pg.verify(c.item.uri, c.path, c.item.size, c.md5 ?? ''));
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
      const now = Date.now();
      if (now - lastShown > 250 || p.doneFiles === p.totalFiles) {
        lastShown = now;
        opts.onProgress({ ...p });
      }
      if (now - lastNotif > 1000) {
        lastNotif = now;
        Pg.updateTransferService(
          t.notifProgress(p.doneFiles, p.totalFiles, humanBytes(p.speed, phoneLang)),
          p.totalBytes ? Math.round((p.doneBytes / p.totalBytes) * 1000) : 0,
          1000,
        );
      }
    });
    finalText = stopRequested ? t.stopped : same.length ? t.notifVerifyDone(same.length) : '';
  } finally {
    Pg.holdWifi(false);
    stopSub.remove();
    Pg.stopTransferService(t.notifVerifyTitle, finalText);
  }
  return { same, different, cancelled: stopRequested };
}

/**
 * Android ou iOS demandent eux-mêmes la confirmation, puis mettent à la corbeille (30 jours).
 * Renvoie ce qui est vraiment parti : sur iPhone, une photo dont un fichier n'a pas été vérifié
 * (ou une rafale incomplète) reste sur le téléphone, et doit rester connue comme « sur le PC ».
 */
export async function moveToTrash(pcId: string, verified: FreeCandidate[]): Promise<FreeCandidate[]> {
  const removed = new Set(await Pg.removeFromPhone(verified.map((c) => c.item.uri), true));
  const gone = verified.filter((c) => removed.has(c.item.uri));
  await patchIndex(pcId, { del: gone.map((c) => c.item.id) });
  return gone;
}

/**
 * Le QR du PC préparé : on se connecte, on vérifie que c'est bien ce PC qui répond à l'adresse,
 * on teste l'écriture. Renvoie le PC prêt à enregistrer (le mot de passe est celui du code).
 */
export async function pairFromCode(
  p: Pairing,
  opts: { id: string; encrypt: boolean; lang: Lang },
): Promise<{ pc: PcSettings; encrypted: boolean; info: LoginInfo }> {
  const info = await Pg.login({ host: p.host, share: '', user: p.user, password: p.password, encrypt: opts.encrypt, identity: '' });
  if (p.name && info.identity && info.identity.toUpperCase() !== p.name.toUpperCase()) {
    throw Object.assign(new Error(t.scanOtherPc(p.name, info.identity)), { code: 'QR_OTHER_PC' });
  }
  // Un PC qui ne sait pas chiffrer : on le dit (le réglage suit), jamais de repli caché.
  const canEncrypt = !(info.dialect && !info.encrypted);
  const identity = info.identity ?? p.name;
  const pc: PcSettings = {
    ...emptySettings,
    id: opts.id,
    host: p.host,
    name: p.name || p.host,
    share: p.share,
    folder: joinPath(p.folder),
    user: p.user,
    encrypt: opts.encrypt && canEncrypt,
    lang: opts.lang,
    identity,
  };
  const connected = await Pg.connect({ host: pc.host, share: pc.share, user: pc.user, password: p.password, encrypt: pc.encrypt, identity });
  await Pg.testWrite(pc.folder);
  return { pc, encrypted: connected.encrypted, info };
}

/**
 * Le PC ne répond plus à son adresse : la box lui en a peut-être donné une autre. On le cherche
 * sur le Wi-Fi par le nom qu'il annonce (retenu à l'appairage) et on renvoie sa nouvelle adresse,
 * ou null. La connexion contrôle de toute façon ce nom avant d'envoyer le mot de passe.
 */
export async function relocate(pc: PcSettings): Promise<string | null> {
  if (!canRelocate(pc.host, pc.identity)) return null;
  return movedTo(await Pg.discover().catch(() => []), pc.host, pc.identity ?? '');
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
