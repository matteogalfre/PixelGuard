// Ce qu'on lit au début d'une photo ou d'une vidéo du PC, sans la télécharger en entier : la date
// de prise de vue (EXIF, ou l'en-tête d'une vidéo) et la petite vignette que les appareils photo
// glissent dans l'EXIF. Sans dépendance, pour être testé avec `node --test`.

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]));

export function fromBase64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const a = B64_INDEX.get(clean[i]) ?? 0;
    const b = B64_INDEX.get(clean[i + 1]) ?? 0;
    const c = B64_INDEX.get(clean[i + 2]);
    const d = B64_INDEX.get(clean[i + 3]);
    out[o++] = (a << 2) | (b >> 4);
    if (c !== undefined) out[o++] = ((b & 15) << 4) | (c >> 2);
    if (c !== undefined && d !== undefined) out[o++] = ((c & 3) << 6) | d;
  }
  return out.subarray(0, o);
}

export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const hasB = i + 1 < bytes.length;
    const hasC = i + 2 < bytes.length;
    const a = bytes[i];
    const b = hasB ? bytes[i + 1] : 0;
    const c = hasC ? bytes[i + 2] : 0;
    out += B64[a >> 2] + B64[((a & 3) << 4) | (b >> 4)];
    out += hasB ? B64[((b & 15) << 2) | (c >> 6)] : '=';
    out += hasC ? B64[c & 63] : '=';
  }
  return out;
}

/** Position de `needle` dans `hay` à partir de `from`, ou -1. */
function indexOf(hay: Uint8Array, needle: number[], from = 0): number {
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let k = 0; k < needle.length; k++) if (hay[i + k] !== needle[k]) continue outer;
    return i;
  }
  return -1;
}

type Tiff = { bytes: Uint8Array; start: number; little: boolean };

function u16(t: Tiff, at: number): number {
  const p = t.start + at;
  if (p + 2 > t.bytes.length) return -1;
  return t.little ? t.bytes[p] | (t.bytes[p + 1] << 8) : (t.bytes[p] << 8) | t.bytes[p + 1];
}

function u32(t: Tiff, at: number): number {
  const p = t.start + at;
  if (p + 4 > t.bytes.length) return -1;
  const b = t.bytes;
  return t.little
    ? (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0
    : ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
}

/** Le bloc EXIF (en-tête TIFF) : dans un JPEG comme dans un HEIC, il suit « Exif\0\0 ». */
function findTiff(bytes: Uint8Array): Tiff | null {
  const at = indexOf(bytes, [0x45, 0x78, 0x69, 0x66, 0, 0]);
  if (at < 0) return null;
  const start = at + 6;
  if (start + 8 > bytes.length) return null;
  const little = bytes[start] === 0x49 && bytes[start + 1] === 0x49;
  const big = bytes[start] === 0x4d && bytes[start + 1] === 0x4d;
  if (!little && !big) return null;
  return { bytes, start, little };
}

type Entry = { tag: number; type: number; count: number; value: number; at: number };

function entries(t: Tiff, ifd: number): Entry[] {
  const n = u16(t, ifd);
  if (n < 0 || n > 500) return [];
  const out: Entry[] = [];
  for (let i = 0; i < n; i++) {
    const at = ifd + 2 + i * 12;
    const tag = u16(t, at);
    if (tag < 0) break;
    out.push({ tag, type: u16(t, at + 2), count: u32(t, at + 4), value: u32(t, at + 8), at: at + 8 });
  }
  return out;
}

function ascii(t: Tiff, e: Entry): string {
  const at = e.count <= 4 ? e.at : e.value;
  let s = '';
  for (let i = 0; i < e.count; i++) {
    const p = t.start + at + i;
    if (p >= t.bytes.length || t.bytes[p] === 0) break;
    s += String.fromCharCode(t.bytes[p]);
  }
  return s;
}

/** « 2026:11:25 14:03:12 » en millisecondes, à l'heure du téléphone (l'EXIF n'a pas de fuseau). */
export function parseExifDate(s: string): number | null {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, se] = m.slice(1).map(Number);
  if (y < 1970 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return new Date(y, mo - 1, d, h, mi, se).getTime();
}

const MAC_EPOCH = Date.UTC(1904, 0, 1);

/** L'heure de création d'une vidéo MP4 ou MOV (boîte « mvhd »), si elle est dans le début lu. */
function videoTaken(bytes: Uint8Array): number | null {
  const at = indexOf(bytes, [0x6d, 0x76, 0x68, 0x64]); // mvhd
  if (at < 0 || at + 12 > bytes.length) return null;
  const v = bytes[at + 4];
  const p = at + 8;
  let secs: number;
  if (v === 1) {
    if (p + 8 > bytes.length) return null;
    secs = 0;
    for (let i = 0; i < 8; i++) secs = secs * 256 + bytes[p + i];
  } else {
    secs = ((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0;
  }
  if (!secs) return null;
  const ms = MAC_EPOCH + secs * 1000;
  return ms > Date.UTC(1971, 0, 1) && ms < Date.UTC(2100, 0, 1) ? ms : null;
}

/** La date de prise de vue lue au début du fichier : EXIF d'abord, puis l'en-tête vidéo. */
export function takenFromHead(bytes: Uint8Array): number | null {
  const t = findTiff(bytes);
  if (t && u16(t, 2) === 42) {
    const ifd0 = u32(t, 4);
    const main = entries(t, ifd0);
    const exifPtr = main.find((e) => e.tag === 0x8769)?.value;
    if (exifPtr) {
      const sub = entries(t, exifPtr);
      for (const tag of [0x9003, 0x9004]) {
        const e = sub.find((x) => x.tag === tag);
        const ms = e ? parseExifDate(ascii(t, e)) : null;
        if (ms) return ms;
      }
    }
    const dt = main.find((e) => e.tag === 0x0132);
    const ms = dt ? parseExifDate(ascii(t, dt)) : null;
    if (ms) return ms;
  }
  return videoTaken(bytes);
}

/**
 * La vignette JPEG rangée dans l'EXIF (IFD1), si elle tient dans le début lu. La plupart des
 * appareils en mettent une de 10 à 20 Ko : de quoi montrer la photo sans la télécharger.
 */
export function thumbnailFromHead(bytes: Uint8Array): Uint8Array | null {
  const t = findTiff(bytes);
  if (!t || u16(t, 2) !== 42) return null;
  const ifd0 = u32(t, 4);
  const n = u16(t, ifd0);
  if (n < 0) return null;
  const ifd1 = u32(t, ifd0 + 2 + n * 12);
  if (!ifd1 || ifd1 < 0) return null;
  const e = entries(t, ifd1);
  const offset = e.find((x) => x.tag === 0x0201)?.value;
  const length = e.find((x) => x.tag === 0x0202)?.value;
  if (!offset || !length) return null;
  const from = t.start + offset;
  if (from + length > bytes.length) return null;
  const thumb = bytes.subarray(from, from + length);
  return thumb[0] === 0xff && thumb[1] === 0xd8 ? thumb : null;
}

/** UTF-8 vers texte (Hermes n'a pas toujours TextDecoder). */
export function utf8(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i++];
    let cp: number;
    if (b < 0x80) cp = b;
    else if (b >= 0xf0) cp = ((b & 7) << 18) | ((bytes[i++] & 63) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    else if (b >= 0xe0) cp = ((b & 15) << 12) | ((bytes[i++] & 63) << 6) | (bytes[i++] & 63);
    else cp = ((b & 31) << 6) | (bytes[i++] & 63);
    out += String.fromCodePoint(cp);
  }
  return out.replace(/^﻿/, '');
}
