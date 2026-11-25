export type Album = { id: string; name: string; path: string; count: number; bytes: number; cover: string };

export type MediaItem = {
  id: string;
  name: string;
  size: number;
  /** Date de prise de vue en ms, 0 si inconnue. */
  taken: number;
  /** Date de modification en ms. */
  modified: number;
  video: boolean;
  bucketId: string;
  bucketName: string;
  relativePath: string;
  uri: string;
};

export type SmbSettings = { host: string; share: string; user: string; password: string; encrypt: boolean };
/**
 * `shares` vaut null si le PC refuse de lister ses dossiers partagés.
 * `encrypted` : contenu chiffré en SMB 3 (sinon seulement signé, lisible sur le réseau).
 */
export type LoginInfo = { dialect: string; signed: boolean; encrypted: boolean; shares: string[] | null };
export type FoundPc = { ip: string; name: string };
export type RemoteEntry = { name: string; size: number; dir: boolean };
export type VerifyResult = { same: boolean; local: string; remote: string | null; missing: boolean };
export type SpeedResult = {
  bytes: number;
  seconds: number;
  dialect: string;
  signed: boolean;
  encrypted: boolean;
  /** « système » (AES matériel) ou « Java » (BouncyCastle). */
  signingCrypto: string;
  maxWrite: number;
};

export type PgApi = {
  listAlbums(): Promise<Album[]>;
  listMedia(bucketIds: string[]): Promise<MediaItem[]>;
  discover(): Promise<FoundPc[]>;
  probe(host: string): Promise<boolean>;
  login(settings: SmbSettings): Promise<LoginInfo>;
  connect(settings: SmbSettings): Promise<LoginInfo>;
  disconnect(): Promise<boolean>;
  list(dir: string): Promise<RemoteEntry[]>;
  mkdirs(dir: string): Promise<boolean>;
  testWrite(dir: string): Promise<{ ok: boolean }>;
  speedTest(dir: string, megabytes: number): Promise<SpeedResult>;
  upload(uri: string, remotePath: string, size: number, transferId: string): Promise<{ bytes: number }>;
  verify(uri: string, remotePath: string, size: number): Promise<VerifyResult>;
  cancel(): void;
  resetCancel(): void;
  holdWifi(on: boolean): void;
  removeFromPhone(uris: string[], toTrash: boolean): Promise<boolean>;
  saveText(name: string, text: string): Promise<boolean>;
  loadText(name: string): Promise<string | null>;
  addListener(event: 'onProgress', cb: (e: { id: string; bytes: number }) => void): { remove(): void };
};
