import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  decide,
  folderState,
  joinPath,
  defaultSorting,
  folderFor,
  keepKind,
  inPeriod,
  monthFolderName,
  monthsOf,
  pickShare,
  plan,
  targetFolders,
  sanitizeSegment,
  splitExt,
  yearMonthFromName,
  yearMonthOf,
} from '../src/logic.ts';

test('dossier du mois comme PixelGuard', () => {
  assert.equal(monthFolderName(2026, 11, 'fr'), '2026 Novembre');
  assert.equal(monthFolderName(2026, 8, 'fr'), '2026 Août');
  assert.equal(monthFolderName(2026, 2, 'en'), '2026 February');
});

test('mois lu dans le nom du fichier', () => {
  assert.deepEqual(yearMonthFromName('20261125_093012.jpg'), [2026, 11]);
  assert.deepEqual(yearMonthFromName('IMG_20250102_101010.jpg'), [2025, 1]);
  assert.deepEqual(yearMonthFromName('VID_20240630_220000.mp4'), [2024, 6]);
  assert.deepEqual(yearMonthFromName('PXL_20230415_120000000.jpg'), [2023, 4]);
  assert.deepEqual(yearMonthFromName('Screenshot_20261003-101010_Chrome.jpg'), [2026, 10]);
  assert.deepEqual(yearMonthFromName('IMG-20260712-WA0003.jpg'), [2026, 7]);
  assert.deepEqual(yearMonthFromName('Capture 2026-09-01 10.11.12.png'), [2026, 9]);
  assert.equal(yearMonthFromName('photo.jpg'), null);
  assert.equal(yearMonthFromName('99991399_x.jpg'), null);
});

test('sinon date de prise de vue, sinon modification', () => {
  const taken = new Date(2025, 4, 20, 12).getTime();
  const modified = new Date(2026, 0, 3, 12).getTime();
  assert.deepEqual(yearMonthOf({ name: 'photo.jpg', taken, modified }), [2025, 5]);
  assert.deepEqual(yearMonthOf({ name: 'photo.jpg', taken: 0, modified }), [2026, 1]);
  assert.deepEqual(yearMonthOf({ name: '20240101_000000.jpg', taken, modified }), [2024, 1]);
});

test('noms propres pour Windows', () => {
  assert.equal(sanitizeSegment('a:b*c?.jpg'), 'a_b_c_.jpg');
  assert.equal(sanitizeSegment('fin. '), 'fin');
  assert.equal(sanitizeSegment(''), '_');
  assert.deepEqual(splitExt('photo.jpg'), ['photo', '.jpg']);
  assert.deepEqual(splitExt('.cache'), ['.cache', '']);
  assert.deepEqual(splitExt('archive.tar.gz'), ['archive.tar', '.gz']);
});

test('même nom et même taille : déjà copié', () => {
  const f = folderState([{ name: 'IMG_1.jpg', size: 100 }]);
  assert.deepEqual(decide('IMG_1.jpg', 100, f), { action: 'skip', remoteName: 'IMG_1.jpg' });
  // Windows ne distingue pas les majuscules
  assert.deepEqual(decide('img_1.JPG', 100, f), { action: 'skip', remoteName: 'IMG_1.jpg' });
});

test('même nom, autre taille : nouveau nom', () => {
  const f = folderState([{ name: 'IMG_1.jpg', size: 100 }, { name: 'IMG_1 (1).jpg', size: 200 }]);
  assert.deepEqual(decide('IMG_1.jpg', 300, f), { action: 'upload', remoteName: 'IMG_1 (2).jpg' });
});

test('une variante déjà copiée sous « nom (1) » est reconnue', () => {
  const f = folderState([{ name: 'IMG_1.jpg', size: 100 }, { name: 'IMG_1 (1).jpg', size: 200 }]);
  assert.deepEqual(decide('IMG_1.jpg', 200, f), { action: 'skip', remoteName: 'IMG_1 (1).jpg' });
});

test('les .part restés en plan ne comptent pas', () => {
  const f = folderState([{ name: 'IMG_1.jpg.part', size: 50 }]);
  assert.deepEqual(decide('IMG_1.jpg', 100, f), { action: 'upload', remoteName: 'IMG_1.jpg' });
});

test('plan : par mois, sans doublon ni collision', () => {
  const t = new Date(2026, 10, 2).getTime();
  const items = [
    { id: 'a', name: '20261101_1.jpg', size: 10, taken: t, modified: t },
    { id: 'b', name: '20261101_1.jpg', size: 10, taken: t, modified: t }, // même photo, autre album
    { id: 'c', name: '20261101_1.jpg', size: 99, taken: t, modified: t }, // autre fichier, même nom
    { id: 'd', name: '20251201_2.jpg', size: 5, taken: t, modified: t },
    { id: 'e', name: 'deja.jpg', size: 7, taken: t, modified: t },
  ];
  const folders = new Map([['2026 Novembre', folderState([{ name: 'deja.jpg', size: 7 }])]]);
  assert.deepEqual(targetFolders(items, defaultSorting, 'fr'), ['2026 Novembre', '2025 Décembre']);
  const p = plan(items, folders, defaultSorting, 'fr').map((e) => [e.item.id, e.folder, e.remoteName, e.action]);
  assert.deepEqual(p, [
    ['a', '2026 Novembre', '20261101_1.jpg', 'upload'],
    ['b', '2026 Novembre', '20261101_1.jpg', 'skip'],
    ['c', '2026 Novembre', '20261101_1 (1).jpg', 'upload'],
    ['d', '2025 Décembre', '20251201_2.jpg', 'upload'],
    ['e', '2026 Novembre', 'deja.jpg', 'skip'],
  ]);
});

test('chemins dans le partage', () => {
  assert.equal(joinPath('', '2026 Novembre', 'a.jpg'), '2026 Novembre/a.jpg');
  assert.equal(joinPath('/Photos\\Tel/', '2026 Mai', 'a.jpg'), 'Photos/Tel/2026 Mai/a.jpg');
});

test('rangements au choix', () => {
  const photo = { name: '20261125_093012.jpg', taken: 0, modified: 0, bucketName: 'Camera', video: false };
  const video = { name: 'VID_20250203_101010.mp4', taken: 0, modified: 0, bucketName: 'WhatsApp Video', video: true };
  const f = (layout: 'month' | 'yearMonth' | 'year' | 'albumMonth' | 'flat', splitKinds = false) =>
    [folderFor(photo, { layout, splitKinds }, 'fr'), folderFor(video, { layout, splitKinds }, 'fr')];
  assert.deepEqual(f('month'), ['2026 Novembre', '2025 Février']);
  assert.deepEqual(f('yearMonth'), ['2026/11 Novembre', '2025/02 Février']);
  assert.deepEqual(f('year'), ['2026', '2025']);
  assert.deepEqual(f('albumMonth'), ['Camera/2026 Novembre', 'WhatsApp Video/2025 Février']);
  assert.deepEqual(f('flat'), ['', '']);
  assert.deepEqual(f('month', true), ['Photos/2026 Novembre', 'Vidéos/2025 Février']);
  assert.deepEqual(f('flat', true), ['Photos', 'Vidéos']);
  assert.equal(folderFor({ ...video, bucketName: 'a:b' }, { layout: 'albumMonth', splitKinds: false }, 'en'), 'a_b/2025 February');
});

test('photos, vidéos ou les deux', () => {
  assert.equal(keepKind({ video: false }, 'all'), true);
  assert.equal(keepKind({ video: true }, 'photos'), false);
  assert.equal(keepKind({ video: true }, 'videos'), true);
  assert.equal(keepKind({ video: false }, 'videos'), false);
});

test('partage présélectionné', () => {
  assert.equal(pickShare(['Admin’s Public Folder', 'Alex’s Public Folder', 'PixelGuard-test', 'alex']), 'PixelGuard-test');
  assert.equal(pickShare(['Users', 'PixelGuard']), 'PixelGuard');
  assert.equal(pickShare(['Admin’s Public Folder', 'Photos']), 'Photos');
  assert.equal(pickShare(['Public']), 'Public');
});

test('période : ce mois-ci, le mois dernier, un mois précis', () => {
  const now = new Date(2026, 0, 15); // 15 janvier 2026
  const jan = { name: '20260103_1.jpg', taken: 0, modified: 0 };
  const dec = { name: '20251231_1.jpg', taken: 0, modified: 0 };
  const sansDate = { name: 'photo.jpg', taken: new Date(2026, 0, 2).getTime(), modified: 0 };
  assert.equal(inPeriod(jan, { kind: 'all' }, now), true);
  assert.equal(inPeriod(jan, { kind: 'thisMonth' }, now), true);
  assert.equal(inPeriod(dec, { kind: 'thisMonth' }, now), false);
  assert.equal(inPeriod(dec, { kind: 'lastMonth' }, now), true); // passage d'année
  assert.equal(inPeriod(sansDate, { kind: 'thisMonth' }, now), true);
  assert.equal(inPeriod(jan, { kind: 'month', year: 2025, month: 12 }, now), false);
  assert.deepEqual(
    monthsOf([{ ...jan, size: 10 }, { ...dec, size: 5 }, { ...jan, name: '20260120_2.jpg', size: 1 }]),
    [{ year: 2026, month: 1, count: 2, bytes: 11 }, { year: 2025, month: 12, count: 1, bytes: 5 }],
  );
});
