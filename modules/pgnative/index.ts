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

/**
 * `encrypt` : à l'appairage (login), chiffré si le PC le permet ; ensuite (connect), chiffré ou
 * erreur NOT_ENCRYPTED, jamais de repli silencieux.
 * `identity` : nom NetBIOS du PC appairé. À la connexion (pas à l'appairage), un PC qui annonce
 * un autre nom dans son défi NTLM ne reçoit ni l'utilisateur ni la réponse au mot de passe
 * (erreur PC_CHANGED). "" : pas encore connu.
 */
export type SmbSettings = { host: string; share: string; user: string; password: string; encrypt: boolean; identity: string };
/**
 * `shares` vaut null si le PC refuse de lister ses dossiers partagés.
 * `encrypted` : contenu chiffré en SMB 3 (sinon seulement signé, lisible sur le réseau).
 * `identity` : le nom NetBIOS que le PC a annoncé, null s'il n'en annonce pas.
 */
export type LoginInfo = { dialect: string; signed: boolean; encrypted: boolean; shares: string[] | null; identity: string | null };
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

/** Une page du petit serveur : chemin (« / »), type, contenu, nom de fichier si à télécharger. */
export type ServedPage = { path: string; type: string; body: string; download: string };

export type PgApi = {
  listAlbums(): Promise<Album[]>;
  listMedia(bucketIds: string[]): Promise<MediaItem[]>;
  /** Change quand la galerie ou l'accès aux photos change ; "" si on ne sait pas (relire). */
  galleryVersion(): Promise<string>;
  discover(): Promise<FoundPc[]>;
  probe(host: string): Promise<boolean>;
  login(settings: SmbSettings): Promise<LoginInfo>;
  connect(settings: SmbSettings): Promise<LoginInfo>;
  disconnect(): Promise<boolean>;
  list(dir: string): Promise<RemoteEntry[]>;
  mkdirs(dir: string): Promise<boolean>;
  /** Taille lue sur chaque fichier (pas dans la liste du dossier), -1 s'il n'existe pas. */
  statFiles(paths: string[]): Promise<number[]>;
  testWrite(dir: string): Promise<{ ok: boolean }>;
  speedTest(dir: string, megabytes: number): Promise<SpeedResult>;
  /** `sourceKey` identifie l'original : seul un « .part » écrit par lui peut être repris. */
  upload(uri: string, remotePath: string, size: number, transferId: string, sourceKey: string): Promise<{ bytes: number }>;
  verify(uri: string, remotePath: string, size: number): Promise<VerifyResult>;
  cancel(): void;
  resetCancel(): void;
  holdWifi(on: boolean): void;
  /** Service de premier plan : la sauvegarde continue écran éteint, avec une notification. */
  startTransferService(title: string, text: string, stopLabel: string): void;
  updateTransferService(text: string, progress: number, max: number): void;
  /** `finalText` vide : la notification disparaît ; sinon elle reste avec ce texte. */
  stopTransferService(title: string, finalText: string): void;
  /** Renvoie les uri vraiment supprimées (Android : toutes ou aucune ; iPhone : photos complètes). */
  removeFromPhone(uris: string[], toTrash: boolean): Promise<string[]>;
  /** Android seulement : lit un QR avec ZXing, renvoie son texte (null si annulé). Sur iPhone, expo-camera. */
  scanQr?(prompt: string): Promise<string | null>;
  /**
   * Un petit serveur web le temps de préparer un PC : le téléphone donne lui-même « Prepare my PC »
   * au navigateur du PC (sur le port 8800 s'il est libre). `ip` : son adresse sur le Wi-Fi.
   */
  startPrepServer?(pages: ServedPage[]): Promise<{ ip: string | null; port: number }>;
  stopPrepServer?(): Promise<boolean>;
  saveText(name: string, text: string): Promise<boolean>;
  loadText(name: string): Promise<string | null>;
  addListener(event: 'onProgress', cb: (e: { id: string; bytes: number }) => void): { remove(): void };
  /** `reason` : « user » (notification), « timeout » (6 h par jour d'Android 15), « background » (iPhone). */
  addListener(event: 'onStopRequested', cb: (e: { reason?: string }) => void): { remove(): void };
};
