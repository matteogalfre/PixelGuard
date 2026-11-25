import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { stats, type Stats } from './engine';
import type { Kinds, Period, Sorting } from './logic';
import { Pg, type Album } from './native';
import { readAccess, type Access } from './permissions';
import {
  defaultPrefs,
  emptySettings,
  loadAlbums,
  loadPrefs,
  loadLastRun,
  loadPassword,
  loadSettings,
  saveAlbums,
  savePassword,
  savePrefs,
  saveSettings,
  type LastRun,
  type PcSettings,
  type Prefs,
} from './store';

type AppCtx = {
  ready: boolean;
  access: Access | 'unknown';
  requestAccess: () => Promise<void>;
  pc: PcSettings;
  password: string;
  savePc: (pc: PcSettings, password: string) => Promise<void>;
  albums: Album[];
  selected: string[];
  setSelected: (ids: string[]) => void;
  kinds: Kinds;
  setKinds: (k: Kinds) => void;
  sorting: Sorting;
  setSorting: (s: Sorting) => void;
  period: Period;
  setPeriod: (p: Period) => void;
  stats: Stats | null;
  refresh: () => Promise<void>;
  lastRun: LastRun | null;
  setLastRun: (r: LastRun) => void;
};

const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp hors du AppProvider');
  return c;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [access, setAccess] = useState<Access | 'unknown'>('unknown');
  const [pc, setPc] = useState<PcSettings>(emptySettings);
  const [password, setPassword] = useState('');
  const [albums, setAlbums] = useState<Album[]>([]);
  const [selected, setSelectedState] = useState<string[]>([]);
  const [st, setStats] = useState<Stats | null>(null);
  const [lastRun, setLastRun] = useState<LastRun | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(defaultPrefs);

  useEffect(() => {
    (async () => {
      const [s, p, a, l, pr] = await Promise.all([loadSettings(), loadPassword(), readAccess(false), loadLastRun(), loadPrefs()]);
      setPrefs(pr);
      setPc(s);
      setPassword(p);
      setAccess(a);
      setLastRun(l);
      setReady(true);
    })();
  }, []);

  const loadAlbumsNow = useCallback(async () => {
    const list = await Pg.listAlbums();
    setAlbums(list);
    const saved = await loadAlbums();
    // Premier lancement : on coche l'appareil photo.
    const ids = saved ?? list.filter((a) => /^DCIM\/Camera\/?$/i.test(a.path)).map((a) => a.id);
    // Même sélection : on garde le même tableau, sinon tout ce qui en dépend se relance.
    setSelectedState((prev) => (prev.length === ids.length && prev.every((x, i) => x === ids[i]) ? prev : ids));
    return ids;
  }, []);

  const refresh = useCallback(async () => {
    if (access !== 'all' && access !== 'limited') return;
    const ids = await loadAlbumsNow();
    setStats(await stats(ids, prefs.kinds, prefs.period));
  }, [access, loadAlbumsNow, prefs.kinds, prefs.period]);

  useEffect(() => {
    if (ready) refresh();
  }, [ready, refresh]);

  // De retour des réglages Android ou d'une autre appli : on relit l'accès et la galerie.
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (state) => {
      if (state !== 'active') return;
      const a = await readAccess(false);
      setAccess(a);
    });
    return () => sub.remove();
  }, []);

  const setSelected = useCallback(
    (ids: string[]) => {
      setSelectedState(ids);
      saveAlbums(ids);
      stats(ids, prefs.kinds, prefs.period).then(setStats);
    },
    [prefs.kinds, prefs.period],
  );

  const updatePrefs = useCallback((next: Prefs) => {
    setPrefs(next);
    savePrefs(next);
  }, []);

  const savePc = useCallback(async (next: PcSettings, pwd: string) => {
    setPc(next);
    setPassword(pwd);
    await Promise.all([saveSettings(next), savePassword(pwd)]);
  }, []);

  const requestAccess = useCallback(async () => {
    setAccess(await readAccess(true));
  }, []);

  return (
    <Ctx.Provider
      value={{
        ready, access, requestAccess, pc, password, savePc, albums, selected, setSelected,
        kinds: prefs.kinds,
        setKinds: (kinds) => updatePrefs({ ...prefs, kinds }),
        sorting: prefs.sorting,
        setSorting: (sorting) => updatePrefs({ ...prefs, sorting }),
        period: prefs.period,
        setPeriod: (period) => updatePrefs({ ...prefs, period }),
        stats: st, refresh, lastRun, setLastRun,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
