import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseDiskReport } from '../src/diskReport.ts';
import { fromBase64, parseExifDate, takenFromHead, thumbnailFromHead, toBase64, utf8 } from '../src/exif.ts';
import { monthOfFolder, quarantinePath, recommendKeep } from '../src/logic.ts';

/** Un début de JPEG avec un EXIF minimal : date de prise de vue et vignette (IFD1). */
function fakeJpeg(date: string, thumb: number[], little = true): Uint8Array {
  const tiff: number[] = [];
  const u16 = (v: number) => (little ? [v & 255, v >> 8] : [v >> 8, v & 255]);
  const u32 = (v: number) =>
    little ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, v >>> 24] : [v >>> 24, (v >> 16) & 255, (v >> 8) & 255, v & 255];
  const entry = (tag: number, type: number, count: number, value: number) => [...u16(tag), ...u16(type), ...u32(count), ...u32(value)];
  const dateBytes = [...date].map((c) => c.charCodeAt(0)).concat(0);
  // Disposition : en-tête (8) | IFD0 à 8 (1 entrée) | IFD Exif à 26 (1 entrée) | IFD1 à 44 (2 entrées) | date à 74 | vignette à 94
  const ifd0 = 8;
  const exif = ifd0 + 2 + 12 + 4;
  const ifd1 = exif + 2 + 12 + 4;
  const dateAt = ifd1 + 2 + 24 + 4;
  const thumbAt = dateAt + dateBytes.length;
  tiff.push(...(little ? [0x49, 0x49] : [0x4d, 0x4d]), ...u16(42), ...u32(ifd0));
  tiff.push(...u16(1), ...entry(0x8769, 4, 1, exif), ...u32(ifd1));
  tiff.push(...u16(1), ...entry(0x9003, 2, dateBytes.length, dateAt), ...u32(0));
  tiff.push(...u16(2), ...entry(0x0201, 4, 1, thumbAt), ...entry(0x0202, 4, 1, thumb.length), ...u32(0));
  tiff.push(...dateBytes, ...thumb);
  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  const len = app1.length + 2;
  return new Uint8Array([0xff, 0xd8, 0xff, 0xe1, len >> 8, len & 255, ...app1, 0xff, 0xd9]);
}

test('base64 et UTF-8 : aller-retour, accents', () => {
  const bytes = new Uint8Array([0, 1, 2, 250, 255, 128, 64]);
  for (let n = 0; n <= bytes.length; n++) {
    const part = bytes.subarray(0, n);
    assert.deepEqual([...fromBase64(toBase64(part))], [...part]);
  }
  assert.equal(toBase64(new Uint8Array([104, 105])), Buffer.from('hi').toString('base64'));
  assert.equal(utf8(new Uint8Array(Buffer.from('\uFEFF2026 Février 📷', 'utf8'))), '2026 Février 📷');
});

test("EXIF : date de prise de vue et vignette, dans les deux ordres d'octets", () => {
  const thumb = [0xff, 0xd8, 1, 2, 3, 0xff, 0xd9];
  for (const little of [true, false]) {
    const jpg = fakeJpeg('2026:11:25 14:03:12', thumb, little);
    assert.equal(takenFromHead(jpg), new Date(2026, 10, 25, 14, 3, 12).getTime());
    assert.deepEqual([...(thumbnailFromHead(jpg) ?? [])], thumb);
  }
  assert.equal(parseExifDate('0000:00:00 00:00:00'), null, 'date vide des appareils sans horloge');
  assert.equal(takenFromHead(new Uint8Array([1, 2, 3])), null);
  // Vignette coupée (le début lu est trop court) : rien plutôt qu'une image cassée.
  const jpg = fakeJpeg('2026:11:25 14:03:12', thumb);
  assert.equal(thumbnailFromHead(jpg.subarray(0, jpg.length - 4)), null);
});

test('vidéo : date de création de la boîte mvhd', () => {
  const secs = Math.round((Date.UTC(2026, 10, 25, 10, 0, 0) - Date.UTC(1904, 0, 1)) / 1000);
  const mvhd = [0, 0, 0, 108, 0x6d, 0x76, 0x68, 0x64, 0, 0, 0, 0, secs >>> 24, (secs >> 16) & 255, (secs >> 8) & 255, secs & 255];
  assert.equal(takenFromHead(new Uint8Array([0, 0, 0, 8, 0x6d, 0x6f, 0x6f, 0x76, ...mvhd])), Date.UTC(2026, 10, 25, 10, 0, 0));
});

test('doublons : garder le bon mois, puis le nom d’origine, puis le chemin le plus court', () => {
  const files = [
    { path: 'Tel/2026 Octobre/IMG_1.jpg', size: 5 },
    { path: 'Tel/2026 Novembre/IMG_1 (1).jpg', size: 5 },
  ];
  assert.deepEqual(recommendKeep(files, 'Tel/2026 Novembre'), { keep: 'Tel/2026 Novembre/IMG_1 (1).jpg', reason: 'month' });
  assert.deepEqual(recommendKeep(files, null), { keep: 'Tel/2026 Octobre/IMG_1.jpg', reason: 'name' });
  const same = [
    { path: 'Tel/a/longer/IMG_2.jpg', size: 1 },
    { path: 'Tel/b/IMG_2.jpg', size: 1 },
  ];
  assert.deepEqual(recommendKeep(same, null), { keep: 'Tel/b/IMG_2.jpg', reason: 'path' });
  assert.equal(quarantinePath('Tel', 'Tel/2026 Octobre/IMG_1.jpg'), 'Tel/_Doublons/2026 Octobre/IMG_1.jpg');
  assert.equal(quarantinePath('', '2026 Octobre/IMG_1.jpg', 2), '_Doublons/2026 Octobre/IMG_1 (2).jpg');
});

test('mois d’un dossier : « 2026 Novembre », « 2026 November », « 2026/11 Novembre »', () => {
  assert.equal(monthOfFolder('2026 Novembre'), 202611);
  assert.equal(monthOfFolder('Camera/2026 November'), 202611);
  assert.equal(monthOfFolder('Photos/2026/02 Février'), 202602);
  assert.equal(monthOfFolder('2026'), null);
  assert.equal(monthOfFolder('Vacances'), null);
});

test('bilan du disque : lu tel que PowerShell l’écrit, refusé sinon', () => {
  const r = parseDiskReport(
    '{"version":1,"label":"Photos","path":"E:\\\\Photos","present":true,"lastSeen":"2026-11-27T10:00:00Z","lastSync":"2026-11-27T10:00:00Z","copied":3,"failed":[],"damaged":["2026 Novembre/x.jpg"],"missing":0,"missingSample":[],"pcFolders":{"2026 Novembre":12},"diskFolders":{"2026 Novembre":"12"}}',
  );
  assert.equal(r?.label, 'Photos');
  assert.equal(r?.path, 'E:\\Photos');
  assert.deepEqual(r?.damaged, ['2026 Novembre/x.jpg']);
  assert.equal(r?.diskFolders['2026 Novembre'], 12);
  assert.equal(parseDiskReport('{"version":2}'), null);
  assert.equal(parseDiskReport('pas du json'), null);
});
