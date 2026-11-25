import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { allTime, defaultSorting, type Kinds, type Period, type Sorting } from './logic';
import { Pg } from './native';

/** `name` : le nom du PC à afficher (DESKTOP-XXXX), `host` : son adresse. */
export type PcSettings = { host: string; name: string; share: string; folder: string; user: string; encrypt: boolean };

export const emptySettings: PcSettings = { host: '', name: '', share: '', folder: '', user: '', encrypt: true };

const K_PC = 'pc';
const K_ALBUMS = 'albums';
const K_LAST = 'lastRun';
const K_PASSWORD = 'smbPassword';
const K_PREFS = 'prefs';
const INDEX_FILE = 'copies.json';

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export const loadSettings = async () => ({ ...emptySettings, ...(await readJson<Partial<PcSettings>>(K_PC, {})) });
export const saveSettings = (s: PcSettings) => AsyncStorage.setItem(K_PC, JSON.stringify(s));

/** D'où viennent les fichiers et comment ils sont rangés sur le PC. */
export type Prefs = { kinds: Kinds; sorting: Sorting; period: Period };
export const defaultPrefs: Prefs = { kinds: 'all', sorting: defaultSorting, period: allTime };
export const loadPrefs = async (): Promise<Prefs> => ({ ...defaultPrefs, ...(await readJson<Partial<Prefs>>(K_PREFS, {})) });
export const savePrefs = (p: Prefs) => AsyncStorage.setItem(K_PREFS, JSON.stringify(p));

/** null tant qu'aucun choix n'a été fait (on coche alors Camera). */
export const loadAlbums = () => readJson<string[] | null>(K_ALBUMS, null);
export const saveAlbums = (ids: string[]) => AsyncStorage.setItem(K_ALBUMS, JSON.stringify(ids));

export type LastRun = { at: number; uploaded: number; skipped: number; failed: number; bytes: number; seconds: number };
export const loadLastRun = () => readJson<LastRun | null>(K_LAST, null);
export const saveLastRun = (r: LastRun) => AsyncStorage.setItem(K_LAST, JSON.stringify(r));

// Le mot de passe reste chiffré dans le Keystore Android (pas dispo dans le navigateur).
let memoryPassword = '';
export async function loadPassword(): Promise<string> {
  try {
    return (await SecureStore.getItemAsync(K_PASSWORD)) ?? '';
  } catch {
    return memoryPassword;
  }
}
export async function savePassword(p: string): Promise<void> {
  try {
    if (p) await SecureStore.setItemAsync(K_PASSWORD, p);
    else await SecureStore.deleteItemAsync(K_PASSWORD);
  } catch {
    memoryPassword = p;
  }
}

/** Ce qu'on sait être sur le PC : id du média -> chemin dans le partage et taille. */
export type CopyIndex = Record<string, { path: string; size: number }>;

export async function loadIndex(): Promise<CopyIndex> {
  try {
    const raw = await Pg.loadText(INDEX_FILE);
    return raw ? (JSON.parse(raw) as CopyIndex) : {};
  } catch {
    return {};
  }
}

export const saveIndex = (idx: CopyIndex) => Pg.saveText(INDEX_FILE, JSON.stringify(idx));
