import { ago, t } from '../i18n';
import type { DiskReport } from '../pcTools';
import { C } from './kit';

/** Le bilan du disque en une ligne : à jour, fichiers en attente, ou pas réglé. */
export function diskLine(report: DiskReport | null | undefined): { text: string; color: string } {
  if (report === undefined) return { text: '…', color: C.muted };
  if (!report) return { text: t.tools.diskNone, color: C.muted };
  if (report.missing > 0 || report.failed.length || report.damaged.length) {
    return { text: t.tools.diskMissing(report.missing + report.failed.length), color: C.warn };
  }
  if (!report.lastSync) return { text: t.tools.diskNever, color: C.muted };
  return { text: t.tools.diskUpToDate(ago(Date.parse(report.lastSync))), color: C.ok };
}
