import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { allTime, defaultSorting, type Kinds, type Period, type Sorting } from './logic';
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
};

export const emptySettings: PcSettings = { id: '', host: '', name: '', share: '', folder: '', user: '', encrypt: true };

export const newPcId = () => `pc${Date.now().toString(36)}`;

const K_PCS = 'pcs';
const K_ACTIVE = 'activePc';
const K_ALBUMS = 'albums';
const K_HISTORY = 'history';
const K_PREFS = 'prefs';
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
  const pcs = await readJson<PcSettings[] | null>(K_PCS, null);
  if (pcs) return { pcs, activeId: (await AsyncStorage.getItem(K_ACTIVE)) ?? pcs[0]?.id ?? '' };
  const old = await readJson<Partial<PcSettings> | null>(OLD_PC, null);
  if (!old?.host) return { pcs: [], activeId: '' };
  const pc: PcSettings = { ...emptySettings, ...old, id: 'pc1' };
  await savePassword(pc.id, await readSecret(OLD_PASSWORD));
  const oldIndex = await Pg.loadText(OLD_INDEX).catch(() => null);
  if (oldIndex) await Pg.saveText(indexFile(pc.id), oldIndex);
  await savePcs([pc], pc.id);
  await writeSecret(OLD_PASSWORD, '');
  await AsyncStorage.removeItem(OLD_PC);
  return { pcs: [pc], activeId: pc.id };
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
export type CopyIndex = Record<string, { path: string; size: number }>;

const indexFile = (pcId: string) => `copies-${pcId}.json`;

export async function loadIndex(pcId: string): Promise<CopyIndex> {
  if (!pcId) return {};
  try {
    const raw = await Pg.loadText(indexFile(pcId));
    return raw ? (JSON.parse(raw) as CopyIndex) : {};
  } catch {
    return {};
  }
}

export const saveIndex = (pcId: string, idx: CopyIndex) => Pg.saveText(indexFile(pcId), JSON.stringify(idx));
