// Le bilan de la synchro du disque dur externe, tel que la tâche du PC l'écrit. Sans dépendance.

/** Le bilan que la tâche « PixelGuard disque dur » laisse sur le PC (voir PixelGuard-PC.cmd). */
export type DiskReport = {
  label: string;
  path: string;
  present: boolean;
  lastSeen: string;
  lastSync: string;
  copied: number;
  failed: string[];
  damaged: string[];
  missing: number;
  missingSample: string[];
  pcFolders: Record<string, number>;
  diskFolders: Record<string, number>;
};

export const DISK_REPORT = '.pixelguard-disque.json';

export function parseDiskReport(text: string): DiskReport | null {
  try {
    const j = JSON.parse(text);
    if (!j || typeof j !== 'object' || j.version !== 1) return null;
    const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : []);
    const map = (v: unknown) =>
      v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, n]) => [k, Number(n) || 0])) : {};
    return {
      label: String(j.label ?? ''),
      path: String(j.path ?? ''),
      present: !!j.present,
      lastSeen: String(j.lastSeen ?? ''),
      lastSync: String(j.lastSync ?? ''),
      copied: Number(j.copied) || 0,
      failed: arr(j.failed),
      damaged: arr(j.damaged),
      missing: Number(j.missing) || 0,
      missingSample: arr(j.missingSample),
      pcFolders: map(j.pcFolders),
      diskFolders: map(j.diskFolders),
    };
  } catch {
    return null;
  }
}
