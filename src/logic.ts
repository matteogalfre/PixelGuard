// Règles reprises de PixelGuard (pixelguard/core.py et transfer.py), sans dépendance,
// pour être testées avec `node --test`.

export type Lang = 'fr' | 'en';

export const MONTHS: Record<Lang, string[]> = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'],
  fr: ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet',
    'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'],
};

/** Nom du dossier du mois, le même que PixelGuard propose par défaut : « 2026 Novembre ». */
export function monthFolderName(year: number, month: number, lang: Lang): string {
  return `${year} ${MONTHS[lang][month - 1]}`;
}

const NAME_DATE_RES: RegExp[] = [
  /^(?<y>\d{4})[-_]?(?<m>\d{2})[-_]?\d{2}/,
  /^IMG[_-](?<y>\d{4})(?<m>\d{2})\d{2}/,
  /^VID[_-](?<y>\d{4})(?<m>\d{2})\d{2}/,
  /^PXL_(?<y>\d{4})(?<m>\d{2})\d{2}/,
  /^Screenshot[_-](?<y>\d{4})(?<m>\d{2})\d{2}/,
  /^(?:IMG|VID)-(?<y>\d{4})(?<m>\d{2})\d{2}-WA/,
  /(?<y>\d{4})[-_:](?<m>\d{2})[-_:]\d{2}[ _T]\d{2}/,
];

export function yearMonthFromName(name: string): [number, number] | null {
  const base = name.split('/').pop() ?? name;
  for (const re of NAME_DATE_RES) {
    const m = re.exec(base);
    if (!m?.groups) continue;
    const y = Number(m.groups.y);
    const mo = Number(m.groups.m);
    if (y >= 1970 && y <= 2100 && mo >= 1 && mo <= 12) return [y, mo];
  }
  return null;
}

export type Dated = { name: string; taken: number; modified: number };

/** Le mois vient du nom du fichier, sinon de la prise de vue, sinon de la modification. */
export function yearMonthOf(item: Dated): [number, number] {
  const fromName = yearMonthFromName(item.name);
  if (fromName) return fromName;
  const ms = item.taken > 0 ? item.taken : item.modified;
  const d = new Date(ms);
  return [d.getFullYear(), d.getMonth() + 1];
}

/** Retire les caractères interdits dans un nom de fichier Windows. */
export function sanitizeSegment(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim().replace(/[. ]+$/, '');
  return cleaned || '_';
}

/** Comme os.path.splitext : « photo.jpg » donne [« photo », « .jpg »]. */
export function splitExt(name: string): [string, string] {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return [name, ''];
  return [name.slice(0, dot), name.slice(dot)];
}

/** « photo (2).jpg » et « photo.jpg » ont la même clé : ce sont des variantes du même nom. */
export function variantKey(name: string): string {
  const [root, ext] = splitExt(name);
  return (root.replace(/ \(\d+\)$/, '') + ext).toLowerCase();
}

export type RemoteFile = { name: string; size: number };

/** Ce qu'on sait d'un dossier du mois sur le PC (Windows ne distingue pas les majuscules). */
export type FolderState = {
  names: Set<string>;
  byKey: Map<string, RemoteFile[]>;
};

export function folderState(files: RemoteFile[]): FolderState {
  const state: FolderState = { names: new Set(), byKey: new Map() };
  for (const f of files) {
    if (f.name.toLowerCase().endsWith('.part')) continue;
    addToFolder(state, f);
  }
  return state;
}

export function addToFolder(state: FolderState, f: RemoteFile): void {
  state.names.add(f.name.toLowerCase());
  const key = variantKey(f.name);
  const list = state.byKey.get(key);
  if (list) list.push(f);
  else state.byKey.set(key, [f]);
}

export type Decision = { action: 'skip' | 'upload'; remoteName: string };

/**
 * Même nom (ou une variante « nom (1) ») et même taille : déjà copié, on saute.
 * Sinon on envoie, sous un nom libre : « nom.jpg », puis « nom (1).jpg »...
 */
export function decide(name: string, size: number, folder: FolderState): Decision {
  const clean = sanitizeSegment(name);
  const same = folder.byKey.get(variantKey(clean))?.find((f) => f.size === size);
  if (same) return { action: 'skip', remoteName: same.name };
  return { action: 'upload', remoteName: freeName(clean, folder) };
}

export function freeName(clean: string, folder: FolderState): string {
  if (!folder.names.has(clean.toLowerCase())) return clean;
  const [root, ext] = splitExt(clean);
  for (let i = 1; ; i++) {
    const candidate = `${root} (${i})${ext}`;
    if (!folder.names.has(candidate.toLowerCase())) return candidate;
  }
}

export type Plannable = Sortable & { size: number };

export type PlanEntry<T> = { item: T; folder: string; remoteName: string; action: 'skip' | 'upload' };

/** D'où viennent les fichiers : tout, seulement les photos, ou seulement les vidéos. */
export type Kinds = 'all' | 'photos' | 'videos';

export function keepKind(item: { video: boolean }, kinds: Kinds): boolean {
  return kinds === 'all' || (kinds === 'videos') === item.video;
}

/**
 * Quels fichiers sauvegarder dans le temps : tout, ce mois-ci, le mois dernier, les N derniers
 * mois, une année, un mois précis, ou de tel mois à tel mois (bornes incluses).
 */
export type Period =
  | { kind: 'all' }
  | { kind: 'thisMonth' }
  | { kind: 'lastMonth' }
  | { kind: 'lastMonths'; n: number }
  | { kind: 'year'; year: number }
  | { kind: 'month'; year: number; month: number }
  | { kind: 'range'; from: number; to: number };

export const allTime: Period = { kind: 'all' };

/** « 2026-11 » s'écrit 202611 : on compare les mois comme des nombres. */
export const ym = (year: number, month: number) => year * 100 + month;

function shiftMonth(now: Date, delta: number): number {
  const d = new Date(now.getFullYear(), now.getMonth() + delta, 1);
  return ym(d.getFullYear(), d.getMonth() + 1);
}

/** Le premier et le dernier mois de la période (null : pas de limite). */
export function periodRange(p: Period, now: Date = new Date()): [number, number] | null {
  switch (p.kind) {
    case 'thisMonth':
      return [shiftMonth(now, 0), shiftMonth(now, 0)];
    case 'lastMonth':
      return [shiftMonth(now, -1), shiftMonth(now, -1)];
    case 'lastMonths':
      return [shiftMonth(now, -(Math.max(1, p.n) - 1)), shiftMonth(now, 0)];
    case 'year':
      return [ym(p.year, 1), ym(p.year, 12)];
    case 'month':
      return [ym(p.year, p.month), ym(p.year, p.month)];
    case 'range':
      return [Math.min(p.from, p.to), Math.max(p.from, p.to)];
    default:
      return null;
  }
}

/** Même règle que le rangement : le mois du nom de fichier, sinon de la prise de vue. */
export function inPeriod(item: Dated, p: Period, now: Date = new Date()): boolean {
  const r = periodRange(p, now);
  if (!r) return true;
  const [y, m] = yearMonthOf(item);
  const k = ym(y, m);
  return k >= r[0] && k <= r[1];
}

export type MonthCount = { year: number; month: number; count: number; bytes: number };

/** Les mois présents dans la galerie, du plus récent au plus ancien. */
export function monthsOf(items: (Dated & { size: number })[]): MonthCount[] {
  const map = new Map<number, MonthCount>();
  for (const it of items) {
    const [year, month] = yearMonthOf(it);
    const key = year * 100 + month;
    const c = map.get(key) ?? { year, month, count: 0, bytes: 0 };
    c.count++;
    c.bytes += it.size;
    map.set(key, c);
  }
  return [...map.entries()].sort((a, b) => b[0] - a[0]).map(([, v]) => v);
}

/** Comment les fichiers sont rangés sur le PC. */
export type Layout = 'month' | 'yearMonth' | 'year' | 'albumMonth' | 'flat';
export type Sorting = { layout: Layout; splitKinds: boolean };
export const defaultSorting: Sorting = { layout: 'month', splitKinds: false };
export const LAYOUTS: Layout[] = ['month', 'yearMonth', 'year', 'albumMonth', 'flat'];

export type Sortable = Dated & { bucketName?: string; video?: boolean };

/**
 * Dossier (relatif au dossier de sauvegarde) où va ce fichier :
 * - month : « 2026 Novembre » (comme PixelGuard en USB)
 * - yearMonth : « 2026/11 Novembre »
 * - year : « 2026 »
 * - albumMonth : « Camera/2026 Novembre »
 * - flat : tout au même endroit
 * Avec splitKinds, tout passe sous « Photos/ » ou « Vidéos/ ».
 */
export function folderFor(item: Sortable, sorting: Sorting, lang: Lang): string {
  const [y, m] = yearMonthOf(item);
  let dir: string;
  switch (sorting.layout) {
    case 'yearMonth':
      dir = `${y}/${String(m).padStart(2, '0')} ${MONTHS[lang][m - 1]}`;
      break;
    case 'year':
      dir = String(y);
      break;
    case 'albumMonth':
      dir = joinPath(sanitizeSegment(item.bucketName || (lang === 'fr' ? 'Autres' : 'Other')), monthFolderName(y, m, lang));
      break;
    case 'flat':
      dir = '';
      break;
    default:
      dir = monthFolderName(y, m, lang);
  }
  if (sorting.splitKinds) dir = joinPath(item.video ? (lang === 'fr' ? 'Vidéos' : 'Videos') : 'Photos', dir);
  return dir;
}

/** Dossiers concernés par ces fichiers, dans l'ordre où on les rencontre. */
export function targetFolders(items: Sortable[], sorting: Sorting, lang: Lang): string[] {
  const seen = new Set<string>();
  for (const it of items) seen.add(folderFor(it, sorting, lang));
  return [...seen];
}

/**
 * Décide pour chaque fichier. Les envois prévus comptent tout de suite dans l'état du
 * dossier : deux fichiers identiques du téléphone (même photo dans deux albums) ne partent
 * qu'une fois, et deux fichiers différents de même nom ne visent jamais le même nom.
 */
export function plan<T extends Plannable>(
  items: T[],
  folders: Map<string, FolderState>,
  sorting: Sorting,
  lang: Lang,
): PlanEntry<T>[] {
  const out: PlanEntry<T>[] = [];
  for (const item of items) {
    const folder = folderFor(item, sorting, lang);
    let state = folders.get(folder);
    if (!state) {
      state = folderState([]);
      folders.set(folder, state);
    }
    const d = decide(item.name, item.size, state);
    if (d.action === 'upload') addToFolder(state, { name: d.remoteName, size: item.size });
    out.push({ item, folder, remoteName: d.remoteName, action: d.action });
  }
  return out;
}

export function joinPath(...parts: string[]): string {
  return parts
    .map((p) => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
}

export function humanBytes(n: number, lang: Lang = 'fr'): string {
  if (!(n >= 0)) return '?';
  const units = lang === 'fr' ? ['o', 'Ko', 'Mo', 'Go', 'To'] : ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  const num = i === 0 ? n.toFixed(0) : n.toFixed(1);
  return `${lang === 'fr' ? num.replace('.', ',') : num} ${units[i]}`;
}

export function humanDuration(seconds: number): string {
  if (!(seconds > 0) || !Number.isFinite(seconds)) return '—';
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
}

/**
 * Le partage à présélectionner : celui de la commande PowerShell (PixelGuard...), sinon le
 * premier qui n'est pas un dossier « Public » (souvent en lecture seule), sinon le premier.
 */
export function pickShare(shares: string[]): string {
  return (
    shares.find((x) => /pixelguard/i.test(x)) ??
    shares.find((x) => !/public|print|imprim/i.test(x)) ??
    shares[0]
  );
}

/**
 * Une copie connue sur le PC : son chemin dans le partage et sa taille. Quand c'est l'appli qui
 * l'a envoyée : `md5` de l'original envoyé et `mod`, sa date de modification à ce moment-là.
 * Tant que l'original n'a pas changé, « Libérer de la place » ne relit que la copie du PC.
 */
export type IndexEntry = { path: string; size: number; md5?: string; mod?: number };
export type CopyIndex = Record<string, IndexEntry>;

/**
 * Un changement d'index : des entrées à poser, d'autres à retirer. On n'écrit plus l'index en
 * entier depuis une copie qui a pu vieillir : chaque changement s'applique sur la dernière
 * version enregistrée.
 */
export type IndexPatch = { set?: CopyIndex; del?: string[] };

export function applyIndexPatch(index: CopyIndex, patch: IndexPatch): CopyIndex {
  const out: CopyIndex = { ...index };
  for (const id of patch.del ?? []) delete out[id];
  Object.assign(out, patch.set ?? {});
  return out;
}

/**
 * Une coupure (Wi-Fi, PC qui a fermé une session restée inactive) : on retente une fois, après
 * une courte pause. Le module natif rouvre une connexion neuve au premier appel suivant.
 */
export async function retryOnce<T>(op: () => Promise<T>, retriable: (e: unknown) => boolean, pauseMs = 800): Promise<T> {
  try {
    return await op();
  } catch (e) {
    if (!retriable(e)) throw e;
    await new Promise((r) => setTimeout(r, pauseMs));
    return op();
  }
}

/**
 * Débit typique des sauvegardes passées (médiane, en octets par seconde), pour estimer la durée
 * d'une grosse sauvegarde. Seulement les vraies (au moins 50 Mo et 10 s), sinon `null`.
 */
export function typicalRate(runs: { bytes: number; seconds: number }[]): number | null {
  const rates = runs
    .filter((r) => r.bytes >= 50e6 && r.seconds >= 10)
    .map((r) => r.bytes / r.seconds)
    .sort((a, b) => a - b);
  return rates.length ? rates[Math.floor(rates.length / 2)] : null;
}

/** Ce que contient le QR affiché par le PC préparé (tools/PixelGuard-PC.cmd). */
export type Pairing = { host: string; name: string; share: string; user: string; password: string; folder: string };

/** Les champs du lien, déjà découpés (paramètres d'un lien ouvert par le système). */
export function pairingFrom(q: Record<string, string | string[] | undefined>): Pairing | null {
  const one = (k: string) => {
    const v = q[k];
    return (Array.isArray(v) ? v[0] : v) ?? '';
  };
  if (one('v') !== '1' || !one('h') || !one('s') || !one('u') || !one('p')) return null;
  return { host: one('h'), name: one('n'), share: one('s'), user: one('u'), password: one('p'), folder: one('f') };
}

/** Le texte lu dans le QR : « pixelguard://pair?v=1&h=…&n=…&s=…&u=…&p=… ». null si ce n'en est pas un. */
export function parsePairing(text: string): Pairing | null {
  const m = /^pixelguard:\/\/pair\?(.*)$/i.exec(text.trim());
  if (!m) return null;
  const q: Record<string, string> = {};
  for (const part of m[1].split('&')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    try {
      q[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1).replace(/\+/g, ' '));
    } catch {
      return null;
    }
  }
  return pairingFrom(q);
}


// ---------------------------------------------------------------- PC qui change d'adresse

/** Seulement pour un PC appairé par son adresse IPv4 et dont on connaît le nom (un nom se résout tout seul). */
export function canRelocate(host: string, identity: string | undefined): boolean {
  return !!identity?.trim() && /^\d{1,3}(\.\d{1,3}){3}$/.test(host.trim());
}

/**
 * La nouvelle adresse du PC parmi ceux trouvés sur le Wi-Fi : un seul qui annonce le même nom, à
 * une autre adresse. Deux PC du même nom, ou aucun : on ne devine pas.
 */
export function movedTo(found: { ip: string; name: string }[], host: string, identity: string): string | null {
  const name = identity.trim().toUpperCase();
  const same = found.filter((f) => f.name.trim().toUpperCase() === name);
  if (same.length !== 1 || same[0].ip === host.trim()) return null;
  return same[0].ip;
}

// ---------------------------------------------------------------- doublons sur le PC

export type DupFile = { path: string; size: number };
/** Pourquoi garder celui-là : le bon mois, le nom d'origine, ou à défaut le chemin le plus court. */
export type DupReason = 'month' | 'name' | 'path';

const dirOfPath = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOfPath = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/**
 * Lequel garder parmi des copies identiques : celle rangée dans le dossier où l'appli la
 * mettrait aujourd'hui (`expectedDir`, d'après la date de prise de vue), puis celle au nom
 * d'origine (pas « nom (1) »), puis le chemin le plus court. Les autres partent dans _Doublons.
 */
export function recommendKeep(files: DupFile[], expectedDir: string | null): { keep: string; reason: DupReason } {
  const want = expectedDir?.toLowerCase() ?? null;
  const inMonth = (f: DupFile) => want !== null && dirOfPath(f.path).toLowerCase() === want;
  const original = (f: DupFile) => !/ \(\d+\)$/.test(splitExt(baseOfPath(f.path))[0]);
  const score = (f: DupFile) => (inMonth(f) ? 4 : 0) + (original(f) ? 2 : 0);
  const sorted = [...files].sort(
    (a, b) => score(b) - score(a) || a.path.length - b.path.length || a.path.localeCompare(b.path),
  );
  const best = sorted[0];
  const reason: DupReason =
    inMonth(best) && files.some((f) => !inMonth(f)) ? 'month' : original(best) && files.some((f) => !original(f)) ? 'name' : 'path';
  return { keep: best.path, reason };
}

/** Où ranger un doublon écarté : sous « _Doublons », au même chemin relatif. */
export function quarantinePath(root: string, path: string, attempt = 0): string {
  const rel = root && path.toLowerCase().startsWith(root.toLowerCase() + '/') ? path.slice(root.length + 1) : path;
  let target = joinPath(root, '_Doublons', rel);
  if (attempt > 0) {
    const [r, ext] = splitExt(target);
    target = `${r} (${attempt})${ext}`;
  }
  return target;
}

// ---------------------------------------------------------------- dossiers des mois

const ALL_MONTHS = [...MONTHS.fr, ...MONTHS.en];

/** Le mois d'un dossier du PC (« 2026 Novembre », « 2026/11 Novembre »), ou null. */
export function monthOfFolder(rel: string): number | null {
  const parts = rel.split('/');
  const last = parts[parts.length - 1] ?? '';
  const m1 = /^(\d{4}) (.+)$/.exec(last);
  if (m1) {
    const i = ALL_MONTHS.findIndex((m) => m.toLowerCase() === m1[2].toLowerCase());
    if (i >= 0) return Number(m1[1]) * 100 + (i % 12) + 1;
  }
  const m2 = /^(\d{2}) .+$/.exec(last);
  const year = parts.length >= 2 ? /^(\d{4})$/.exec(parts[parts.length - 2]) : null;
  if (m2 && year) {
    const mo = Number(m2[1]);
    if (mo >= 1 && mo <= 12) return Number(year[1]) * 100 + mo;
  }
  return null;
}
