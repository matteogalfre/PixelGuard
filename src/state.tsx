import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { AppState } from 'react-native';

import { onPcIdentified, stats, type Preview, type Stats } from './engine';
import { forgetGallery, galleryAlbums } from './gallery';
import type { Kinds, Period, Sorting } from './logic';
import type { Album } from './native';
import { openSettings, readAccess, widenAccess, type Access } from './permissions';
import {
  addRun,
  defaultPrefs,
  emptySettings,
  loadAlbums,
  loadHistory,
  loadPassword,
  loadPcs,
  loadPrefs,
  loadWelcomeDone,
  saveAlbums,
  savePassword,
  savePcs,
  savePrefs,
  saveWelcomeDone,
  type PcSettings,
  type Prefs,
  type Run,
} from './store';

type AppCtx = {
  ready: boolean;
  /** Premier lancement terminé : sinon l'accueil ouvre les trois écrans de bienvenue. */
  welcomeDone: boolean;
  finishWelcome: () => Promise<void>;
  access: Access | 'unknown';
  requestAccess: () => Promise<void>;
  /** Accès partiel : ouvre le choix des photos visibles. */
  moreAccess: () => Promise<void>;
  /** Tous les PC enregistrés, et celui vers lequel on sauvegarde. */
  pcs: PcSettings[];
  pc: PcSettings;
  password: string;
  savePc: (pc: PcSettings, password: string) => Promise<void>;
  removePc: (id: string) => Promise<void>;
  setActivePc: (id: string) => Promise<void>;
  passwordOf: (id: string) => Promise<string>;
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
  /** La dernière comparaison avec le PC, et les médias retirés à la main de l'envoi. */
  preview: Preview | null;
  setPreview: (p: Preview | null) => void;
  excluded: Set<string>;
  setExcluded: (s: Set<string>) => void;
  history: Run[];
  addToHistory: (r: Run) => Promise<void>;
};

const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useApp hors du AppProvider');
  return c;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [welcomeDone, setWelcomeDone] = useState(true);
  const [access, setAccess] = useState<Access | 'unknown'>('unknown');
  const [pcs, setPcs] = useState<PcSettings[]>([]);
  const [activeId, setActiveId] = useState('');
  const [password, setPassword] = useState('');
  const [albums, setAlbums] = useState<Album[]>([]);
  const [selected, setSelectedState] = useState<string[]>([]);
  const [st, setStats] = useState<Stats | null>(null);
  const [prefs, setPrefs] = useState<Prefs>(defaultPrefs);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<Run[]>([]);

  const pc = useMemo(() => pcs.find((p) => p.id === activeId) ?? emptySettings, [pcs, activeId]);

  useEffect(() => {
    (async () => {
      const [list, a, h, pr, seen] = await Promise.all([loadPcs(), readAccess(false), loadHistory(), loadPrefs(), loadWelcomeDone()]);
      // Quelqu'un qui avait déjà un PC avant cette version n'a pas besoin de la bienvenue.
      setWelcomeDone(seen || list.pcs.length > 0);
      setPrefs(pr);
      setPcs(list.pcs);
      setActiveId(list.activeId);
      setPassword(list.activeId ? await loadPassword(list.activeId) : '');
      setAccess(a);
      setHistory(h);
      setReady(true);
    })();
  }, []);

  const loadAlbumsNow = useCallback(async () => {
    const list = await galleryAlbums();
    setAlbums(list);
    const saved = await loadAlbums();
    // Premier lancement : on coche l'appareil photo (la Pellicule sur iPhone).
    const ids = saved ?? list.filter((a) => /^DCIM\/Camera\/?$/i.test(a.path) || a.path === 'photos://library').map((a) => a.id);
    // Même sélection : on garde le même tableau, sinon tout ce qui en dépend se relance.
    setSelectedState((prev) => (prev.length === ids.length && prev.every((x, i) => x === ids[i]) ? prev : ids));
    return ids;
  }, []);

  const refresh = useCallback(async () => {
    if (access !== 'all' && access !== 'limited') return;
    const ids = await loadAlbumsNow();
    setStats(await stats(ids, prefs.kinds, prefs.period, activeId));
  }, [access, loadAlbumsNow, prefs.kinds, prefs.period, activeId]);

  useEffect(() => {
    if (ready) refresh();
  }, [ready, refresh]);

  // Un PC enregistré avant le contrôle du nom vient d'être identifié (déjà écrit sur le disque).
  useEffect(() => {
    onPcIdentified((id, identity) =>
      setPcs((prev) => prev.map((p) => (p.id === id && !p.identity ? { ...p, identity } : p))),
    );
    return () => onPcIdentified(null);
  }, []);

  // Une autre sélection, un autre PC : l'ancienne comparaison et les exclusions ne valent plus.
  useEffect(() => {
    setPreview(null);
    setExcluded(new Set());
  }, [selected, prefs.kinds, prefs.period, prefs.sorting, activeId]);

  // De retour des réglages Android ou d'une autre appli : on relit l'accès et la galerie.
  useEffect(() => {
    const sub = AppState.addEventListener('change', async (state) => {
      if (state !== 'active') return;
      // Photos prises ou sélection d'accès changée pendant ce temps : on relira la galerie.
      forgetGallery();
      setAccess(await readAccess(false));
    });
    return () => sub.remove();
  }, []);

  const setSelected = useCallback((ids: string[]) => {
    setSelectedState(ids);
    saveAlbums(ids);
  }, []);

  useEffect(() => {
    if (ready && (access === 'all' || access === 'limited')) {
      stats(selected, prefs.kinds, prefs.period, activeId).then(setStats);
    }
  }, [selected, ready, access, prefs.kinds, prefs.period, activeId]);

  const updatePrefs = useCallback((next: Prefs) => {
    setPrefs(next);
    savePrefs(next);
  }, []);

  const savePc = useCallback(
    async (next: PcSettings, pwd: string) => {
      const list = pcs.some((p) => p.id === next.id) ? pcs.map((p) => (p.id === next.id ? next : p)) : [...pcs, next];
      setPcs(list);
      setActiveId(next.id);
      setPassword(pwd);
      await Promise.all([savePcs(list, next.id), savePassword(next.id, pwd)]);
    },
    [pcs],
  );

  const removePc = useCallback(
    async (id: string) => {
      const list = pcs.filter((p) => p.id !== id);
      const nextActive = id === activeId ? (list[0]?.id ?? '') : activeId;
      setPcs(list);
      setActiveId(nextActive);
      setPassword(nextActive ? await loadPassword(nextActive) : '');
      await Promise.all([savePcs(list, nextActive), savePassword(id, '')]);
    },
    [pcs, activeId],
  );

  const setActivePc = useCallback(
    async (id: string) => {
      setActiveId(id);
      setPassword(await loadPassword(id));
      await savePcs(pcs, id);
    },
    [pcs],
  );

  const addToHistory = useCallback(async (r: Run) => {
    setHistory(await addRun(r));
  }, []);

  const finishWelcome = useCallback(async () => {
    setWelcomeDone(true);
    await saveWelcomeDone();
  }, []);

  const requestAccess = useCallback(async () => {
    forgetGallery();
    // Refusé pour de bon : seul l'écran des réglages peut le rendre (relu au retour dans l'appli).
    if (access === 'blocked') return openSettings();
    setAccess(await readAccess(true));
  }, [access]);

  /** Accès partiel : choisir d'autres photos, puis relire la galerie. */
  const moreAccess = useCallback(async () => {
    await widenAccess();
    forgetGallery();
    setAccess(await readAccess(false));
    refresh();
  }, [refresh]);

  return (
    <Ctx.Provider
      value={{
        ready, welcomeDone, finishWelcome, access, requestAccess, moreAccess,
        pcs, pc, password, savePc, removePc, setActivePc, passwordOf: loadPassword,
        albums, selected, setSelected,
        kinds: prefs.kinds,
        setKinds: (kinds) => updatePrefs({ ...prefs, kinds }),
        sorting: prefs.sorting,
        setSorting: (sorting) => updatePrefs({ ...prefs, sorting }),
        period: prefs.period,
        setPeriod: (period) => updatePrefs({ ...prefs, period }),
        stats: st, refresh,
        preview, setPreview, excluded, setExcluded,
        history, addToHistory,
      }}
    >
      {children}
    </Ctx.Provider>
  );
}
