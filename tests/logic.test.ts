import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  addToFolder,
  applyIndexPatch,
  decide,
  folderState,
  parsePairing,
  retryOnce,
  typicalRate,
  joinPath,
  defaultSorting,
  folderFor,
  keepKind,
  inPeriod,
  periodRange,
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

test('période : derniers mois, année, de tel mois à tel mois', () => {
  const now = new Date(2026, 1, 10); // 10 février 2026
  const nov = { name: '20251120_1.jpg', taken: 0, modified: 0 };
  const fev = { name: '20260201_1.jpg', taken: 0, modified: 0 };
  assert.deepEqual(periodRange({ kind: 'lastMonths', n: 3 }, now), [202512, 202602]);
  assert.equal(inPeriod(nov, { kind: 'lastMonths', n: 3 }, now), false);
  assert.equal(inPeriod(nov, { kind: 'lastMonths', n: 4 }, now), true);
  assert.equal(inPeriod(nov, { kind: 'year', year: 2025 }, now), true);
  assert.equal(inPeriod(fev, { kind: 'year', year: 2025 }, now), false);
  assert.equal(inPeriod(nov, { kind: 'range', from: 202511, to: 202601 }, now), true);
  assert.equal(inPeriod(fev, { kind: 'range', from: 202511, to: 202601 }, now), false);
  // bornes dans le désordre : on remet dans l'ordre
  assert.deepEqual(periodRange({ kind: 'range', from: 202603, to: 202511 }, now), [202511, 202603]);
  assert.equal(periodRange({ kind: 'all' }, now), null);
});

test("index : un changement s'applique sur la dernière version", () => {
  const disk = { a: { path: 'x/a.jpg', size: 1 }, b: { path: 'x/b.jpg', size: 2 } };
  // une autre comparaison a ajouté « c » entre-temps : la sauvegarde ne doit pas l'effacer
  const later = applyIndexPatch(disk, { set: { c: { path: 'x/c.jpg', size: 3 } } });
  const out = applyIndexPatch(later, { set: { d: { path: 'x/d.jpg', size: 4 } }, del: ['a'] });
  assert.deepEqual(Object.keys(out).sort(), ['b', 'c', 'd']);
  assert.equal(disk.a.size, 1, "l'original n'est pas modifié");
});

test('nom promis à un autre envoi : jamais repris, jamais pris pour « déjà là »', () => {
  // sur le PC : IMG.jpg (autre contenu) ; IMG (1).jpg est promis à un envoi en cours
  const f = folderState([{ name: 'IMG.jpg', size: 10 }]);
  addToFolder(f, { name: 'img (1).jpg', size: -2 });
  assert.deepEqual(decide('IMG.jpg', 20, f), { action: 'upload', remoteName: 'IMG (2).jpg' });
});

test('coupure : un seul nouvel essai, et seulement pour une coupure', async () => {
  const lost = Object.assign(new Error('perdue'), { code: 'CONNECTION' });
  const isLost = (e: unknown) => (e as { code?: string }).code === 'CONNECTION';
  let calls = 0;
  const flaky = async () => {
    if (++calls === 1) throw lost;
    return 'ok';
  };
  assert.equal(await retryOnce(flaky, isLost, 0), 'ok');
  assert.equal(calls, 2);

  calls = 0;
  const dead = async () => {
    calls++;
    throw lost;
  };
  await assert.rejects(retryOnce(dead, isLost, 0), /perdue/);
  assert.equal(calls, 2, 'pas plus de deux essais');

  calls = 0;
  const refused = async () => {
    calls++;
    throw Object.assign(new Error('refus'), { code: 'SMB' });
  };
  await assert.rejects(retryOnce(refused, isLost, 0), /refus/);
  assert.equal(calls, 1, 'un refus du PC ne se retente pas');
});

test('débit typique : la médiane des vraies sauvegardes, rien sans historique', () => {
  assert.equal(typicalRate([]), null);
  assert.equal(typicalRate([{ bytes: 10e6, seconds: 1 }]), null, 'trop petite pour compter');
  const runs = [
    { bytes: 600e6, seconds: 20 }, // 30 Mo/s
    { bytes: 400e6, seconds: 40 }, // 10 Mo/s
    { bytes: 1000e6, seconds: 20 }, // 50 Mo/s
    { bytes: 5e6, seconds: 30 }, // ignorée
  ];
  assert.equal(typicalRate(runs), 30e6);
});

test('QR du PC : lien lu, et refus de tout le reste', () => {
  const link = 'pixelguard://pair?v=1&h=192.168.1.20&n=DESKTOP-AB12CD&s=PixelGuard&u=pixelguard&p=k7mq-x2p9-dh4t-r8zn';
  assert.deepEqual(parsePairing(link), {
    host: '192.168.1.20', name: 'DESKTOP-AB12CD', share: 'PixelGuard', user: 'pixelguard', password: 'k7mq-x2p9-dh4t-r8zn', folder: '',
  });
  assert.equal(parsePairing('  ' + link + '\n')?.host, '192.168.1.20', 'espaces autour tolérés');
  assert.equal(parsePairing('https://example.com/?h=1'), null);
  assert.equal(parsePairing('pixelguard://pair?v=2&h=1&s=a&u=b&p=c'), null, 'version inconnue');
  assert.equal(parsePairing('pixelguard://pair?v=1&h=1&s=a&u=b'), null, 'sans mot de passe');
  assert.equal(parsePairing('pixelguard://pair?v=1&h=1&s=a&u=b&p=%E0'), null, 'encodage cassé');
  assert.equal(parsePairing('pixelguard://pair?v=1&h=1&s=Mes%20photos&u=b&p=c')?.share, 'Mes photos');
});

test("le fichier donné par l'appli est bien tools/PixelGuard-PC.cmd (npm run embed-prep)", () => {
  const embedded = readFileSync(new URL('../src/prepScript.ts', import.meta.url), 'utf8');
  const script = readFileSync(new URL('../tools/PixelGuard-PC.cmd', import.meta.url), 'utf8');
  assert.ok(embedded.includes(JSON.stringify(script)), 'relancer : npm run embed-prep');
});

