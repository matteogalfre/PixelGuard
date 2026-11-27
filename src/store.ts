import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { lang as phoneLang } from './i18n';
import {
  allTime,
  applyIndexPatch,
  defaultSorting,
  type CopyIndex,
  type IndexPatch,
  type Kinds,
  type Lang,
  type Period,
  type Sorting,
} from './logic';
import { Pg } from './native';

/**
 * Un PC de destination. `name` : le nom à afficher (DESKTOP-XXXX), `host` : son adresse.
 * Chaque PC a son mot de passe (Keystore) et sa liste de copies.
 */
export type PcSettings = {
  id: string;
  host: string;
  name: string;
  share: string;
  folder: string;
  user: string;
  encrypt: boolean;
  /**
   * Langue des noms de dossiers du mois sur ce PC (« 2026 Novembre » ou « 2026 November »).
   * Fixée à l'ajout du PC : si la langue du téléphone change, on ne recopie pas tout.
   */
  lang?: Lang;
  /**
   * Nom NetBIOS que le PC annonce (DESKTOP-XXXX), retenu à l'appairage. Un appareil qui répond à
   * la même adresse sous un autre nom (hôtel, autre réseau) ne reçoit pas le mot de passe.
   */
  identity?: string;
};

export const emptySettings: PcSettings = { id: '', host: '', name: '', share: '', folder: '', user: '', encrypt: true };

export const newPcId = () => `pc${Date.now().toString(36)}`;

const K_PCS = 'pcs';
const K_ACTIVE = 'activePc';
const K_ALBUMS = 'albums';
const K_HISTORY = 'history';
const K_PREFS = 'prefs';
const K_WELCOME = 'welcomeDone';
// Anciennes clés, d'avant les PC multiples : reprises une fois puis effacées.
const OLD_PC = 'pc';
const OLD_PASSWORD = 'smbPassword';
const OLD_LAST = 'lastRun';
const OLD_INDEX = 'copies.json';

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------- mots de passe

// Rangés chiffrés dans le Keystore Android (pas dispo dans le navigateur : mémoire seulement).
const memory = new Map<string, string>();
const passwordKey = (id: string) => `smbPassword_${id}`;

async function readSecret(key: string): Promise<string> {
  try {
    return (await SecureStore.getItemAsync(key)) ?? '';
  } catch {
    return memory.get(key) ?? '';
  }
}

async function writeSecret(key: string, value: string): Promise<void> {
  try {
    if (value) await SecureStore.setItemAsync(key, value);
    else await SecureStore.deleteItemAsync(key);
  } catch {
    memory.set(key, value);
  }
}

export const loadPassword = (id: string) => readSecret(passwordKey(id));
export const savePassword = (id: string, p: string) => writeSecret(passwordKey(id), p);

// ---------------------------------------------------------------- PC

export type PcList = { pcs: PcSettings[]; activeId: string };

/** Les PC enregistrés, en reprenant le réglage d'avant (un seul PC) s'il existe. */
export async function loadPcs(): Promise<PcList> {
  const stored = await readJson<PcSettings[] | null>(K_PCS, null);
  if (stored) {
    const activeId = (await AsyncStorage.getItem(K_ACTIVE)) ?? stored[0]?.id ?? '';
    // PC ajoutés avant le réglage de langue : on fige la langue d'aujourd'hui.
    if (stored.some((p) => !p.lang)) {
      const pcs = stored.map((p) => (p.lang ? p : { ...p, lang: phoneLang }));
      await savePcs(pcs, activeId);
      return { pcs, activeId };
    }
    return { pcs: stored, activeId };
  }
  const old = await readJson<Partial<PcSettings> | null>(OLD_PC, null);
  if (!old?.host) return { pcs: [], activeId: '' };
  const pc: PcSettings = { ...emptySettings, ...old, id: 'pc1', lang: phoneLang };
  await savePassword(pc.id, await readSecret(OLD_PASSWORD));
  const oldIndex = await Pg.loadText(OLD_INDEX).catch(() => null);
  if (oldIndex) await Pg.saveText(indexFile(pc.id), oldIndex);
  await savePcs([pc], pc.id);
  await writeSecret(OLD_PASSWORD, '');
  await AsyncStorage.removeItem(OLD_PC);
  return { pcs: [pc], activeId: pc.id };
}

/** Un PC enregistré avant le contrôle du nom : le nom vu à sa première connexion fait foi. */
export async function rememberIdentity(pcId: string, identity: string): Promise<void> {
  const pcs = await readJson<PcSettings[] | null>(K_PCS, null);
  if (!pcs?.some((p) => p.id === pcId && !p.identity)) return;
  await AsyncStorage.setItem(K_PCS, JSON.stringify(pcs.map((p) => (p.id === pcId ? { ...p, identity } : p))));
}

export async function savePcs(pcs: PcSettings[], activeId: string): Promise<void> {
  await AsyncStorage.multiSet([
    [K_PCS, JSON.stringify(pcs)],
    [K_ACTIVE, activeId],
  ]);
}

// ---------------------------------------------------------------- préférences

/** D'où viennent les fichiers et comment ils sont rangés sur le PC. */
export type Prefs = { kinds: Kinds; sorting: Sorting; period: Period };
export const defaultPrefs: Prefs = { kinds: 'all', sorting: defaultSorting, period: allTime };
export const loadPrefs = async (): Promise<Prefs> => ({ ...defaultPrefs, ...(await readJson<Partial<Prefs>>(K_PREFS, {})) });
export const savePrefs = (p: Prefs) => AsyncStorage.setItem(K_PREFS, JSON.stringify(p));

/** null tant qu'aucun choix n'a été fait (on coche alors Camera). */
export const loadAlbums = () => readJson<string[] | null>(K_ALBUMS, null);

/** Les trois écrans du premier lancement ont été vus (ou passés). */
export const loadWelcomeDone = async () => (await AsyncStorage.getItem(K_WELCOME)) === '1';
export const saveWelcomeDone = () => AsyncStorage.setItem(K_WELCOME, '1');
export const saveAlbums = (ids: string[]) => AsyncStorage.setItem(K_ALBUMS, JSON.stringify(ids));

// ---------------------------------------------------------------- historique

export type Run = {
  at: number;
  pcName: string;
  uploaded: number;
  skipped: number;
  failed: number;
  bytes: number;
  seconds: number;
  cancelled: boolean;
  encrypted: boolean;
};

const HISTORY_MAX = 100;

export async function loadHistory(): Promise<Run[]> {
  const list = await readJson<Run[] | null>(K_HISTORY, null);
  if (list) return list;
  const old = await readJson<Omit<Run, 'pcName' | 'cancelled' | 'encrypted'> | null>(OLD_LAST, null);
  return old ? [{ ...old, pcName: '', cancelled: false, encrypted: false }] : [];
}

export async function addRun(run: Run): Promise<Run[]> {
  const list = [run, ...(await loadHistory())].slice(0, HISTORY_MAX);
  await AsyncStorage.setItem(K_HISTORY, JSON.stringify(list));
  return list;
}

// ---------------------------------------------------------------- copies connues

/** Ce qu'on sait être sur un PC : id du média -> chemin dans le partage et taille. */
export type { CopyIndex } from './logic';

const indexFile = (pcId: string) => `copies-${pcId}.json`;

// Dernière version enregistrée de chaque index, gardée en mémoire : sur une grosse galerie, relire
// et décoder tout le fichier à chaque changement coûte cher.
const indexCache = new Map<string, CopyIndex>();

/** Une copie de l'index : celui qui l'utilise peut la modifier sans toucher à la référence. */
export async function loadIndex(pcId: string): Promise<CopyIndex> {
  if (!pcId) return {};
  const cached = indexCache.get(pcId);
  if (cached) return { ...cached };
  let raw: string | null = null;
  try {
    raw = await Pg.loadText(indexFile(pcId));
    const index = raw ? (JSON.parse(raw) as CopyIndex) : {};
    indexCache.set(pcId, index);
    return { ...index };
  } catch {
    // Illisible : on le met de côté au lieu de l'écraser au prochain enregistrement, une seule
    // fois (sinon chaque lecture en ferait une copie de plus).
    if (raw) await Pg.saveText(`${indexFile(pcId)}.illisible-${Date.now()}`, raw).catch(() => {});
    indexCache.set(pcId, {});
    return {};
  }
}

// Les changements d'un même PC passent un par un, chacun sur la dernière version enregistrée :
// une comparaison et une sauvegarde qui finissent en même temps ne s'effacent plus.
const queues = new Map<string, Promise<void>>();

export function patchIndex(pcId: string, patch: IndexPatch): Promise<void> {
  if (!pcId || (!patch.del?.length && !Object.keys(patch.set ?? {}).length)) return Promise.resolve();
  const previous = queues.get(pcId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(async () => {
      const next = applyIndexPatch(await loadIndex(pcId), patch);
      await Pg.saveText(indexFile(pcId), JSON.stringify(next));
      indexCache.set(pcId, next);
    });
  queues.set(pcId, next);
  return next;
}
