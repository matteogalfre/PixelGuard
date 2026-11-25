import { getLocales } from 'expo-localization';
import { Platform } from 'react-native';

import { periodRange, type Lang, type Period } from './logic';

const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);
const ios = Platform.OS === 'ios';

/**
 * Commande à coller dans PowerShell (ou Terminal) sur le PC Windows. Elle crée et partage
 * `Images\PixelGuard`, ouvre le partage de fichiers sur le réseau privé, et peut être relancée
 * sans erreur. Pas en administrateur ? Elle se relance toute seule avec la demande de Windows.
 */
export function powershell(done: string): string {
  const script =
    '$d="$env:USERPROFILE\\Pictures\\PixelGuard"; md $d -Force >$null; ' +
    'if(-not(Get-SmbShare -Name PixelGuard -EA 0)){New-SmbShare -Name PixelGuard -Path $d -FullAccess "$env:USERDOMAIN\\$env:USERNAME" >$null}; ' +
    'Get-NetFirewallRule -Group "@FirewallAPI.dll,-28502" | ? Profile -like "*Private*" | Enable-NetFirewallRule; ' +
    `Write-Host "${done} $d" -ForegroundColor Green`;
  return (
    `$s='${script}'; ` +
    'if(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(544)){iex $s}' +
    "else{Start-Process powershell -Verb RunAs -ArgumentList '-NoExit','-EncodedCommand',([Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($s)))}"
  );
}

const fr = {
  demo: 'Démo navigateur : rien ne bouge vraiment',

  permTitle: 'Tes photos restent chez toi',
  permText: "PixelGuard copie tes photos et vidéos sur ton PC, par ton Wi-Fi. Pas de cloud, pas de compte. Il lui faut l'accès à la galerie.",
  permButton: "Autoriser l'accès",
  permLimited: "Accès partiel : PixelGuard ne voit que les photos choisies. Donne l'accès complet dans les réglages Android.",

  tagline: 'Tes photos, sur ton PC.',
  safe: "à l'abri",
  allSafe: "Tout est à l'abri",
  pending: (n: number, size: string) => `${n} ${plural(n, 'nouveau', 'nouveaux')} · ${size}`,
  firstRun: (n: number, size: string) => `${n} fichiers · ${size} à vérifier`,
  noPc: 'Choisir ton PC',
  online: 'en ligne',
  offline: 'hors ligne',
  noAlbum: 'Aucun album choisi',
  albumsCount: (n: number) => `${n} ${plural(n, 'album', 'albums')}`,
  backupN: (n: number) => `Sauvegarder ${n} ${plural(n, 'fichier', 'fichiers')}`,
  backup: 'Sauvegarder',
  checkAgain: 'Revérifier avec le PC',
  stop: 'Arrêter',
  wifiOnly: 'Connecte-toi au Wi-Fi de la maison : PixelGuard ne passe que par le réseau local.',
  phase: {
    connect: 'Connexion au PC',
    scan: 'Lecture de la galerie',
    compare: 'Ce que le PC a déjà',
    send: 'Envoi',
    verify: 'Vérification',
    done: 'Terminé',
  },
  files: (done: number, total: number) => `${done} / ${total}`,
  left: (d: string) => `encore ${d}`,
  perSecond: '/s',
  result: (up: number, skip: number, fail: number) =>
    `${up} ${plural(up, 'copié', 'copiés')} · ${skip} déjà là${fail ? ` · ${fail} ${plural(fail, 'échec', 'échecs')}` : ''}`,
  resultTime: (size: string, dur: string) => `${size} en ${dur}`,
  stopped: 'Arrêtée en cours de route',
  lastRun: (when: string) => `Dernière sauvegarde ${when}`,
  freeRow: 'Libérer de la place',
  freeRowSub: (size: string) => `${size} déjà sur le PC`,
  pcRow: 'PC et réglages',

  onPc: 'déjà sur le PC',
  notCompared: 'pas encore comparé',
  allOnPc: 'Tout est sur le PC',
  toSend: (n: number, size: string) => `${n} à envoyer · ${size}`,
  noFiles: 'Aucun fichier pour cette période',
  comparing: 'Comparaison avec le PC…',
  offlineStatus: 'PC hors ligne : impossible de comparer',
  knownOnly: 'd’après la dernière comparaison',
  reviewTitle: 'À envoyer',
  reviewSub: 'Touche une photo ou une vidéo pour la retirer de cet envoi.',
  reviewCount: (n: number, total: number, size: string) => `${n} sur ${total} · ${size}`,
  selectAll: 'Tout cocher',
  selectNone: 'Tout décocher',
  noVideos: 'Sans les vidéos',
  noPhotos: 'Sans les photos',
  done: 'Valider',
  choose: 'Choisir',
  excludedNote: (n: number) => `${n} ${plural(n, 'retiré', 'retirés')} de cet envoi`,
  historyTitle: 'Historique',
  historySub: 'Les sauvegardes passées, de la plus récente à la plus ancienne.',
  historyEmpty: 'Aucune sauvegarde pour l’instant.',
  historySpeed: (v: string) => `${v}/s`,
  historyRow: (up: number, skip: number, fail: number) =>
    `${up} ${plural(up, 'copié', 'copiés')} · ${skip} déjà là${fail ? ` · ${fail} ${plural(fail, 'échec', 'échecs')}` : ''}`,
  pcsTitle: 'Tes PC',
  pcsSub: 'Choisis où part la prochaine sauvegarde.',
  addPc: 'Ajouter un PC',
  edit: 'Modifier',
  active: 'Destination actuelle',
  editPcTitle: 'Nouveau PC',
  notifTitle: 'Sauvegarde PixelGuard',
  notifProgress: (done: number, total: number, speed: string) => `${done} / ${total} fichiers · ${speed}/s`,
  cmpTitle: 'Sur le PC',
  cmpRunning: 'Comparaison avec le PC…',
  cmpAlready: (n: number, size: string) => `${n} déjà sur le PC (${size})`,
  cmpMissing: (n: number, size: string) => `${n} ${plural(n, 'manque', 'manquent')} · ${size}`,
  cmpNothingMissing: 'Rien ne manque',
  cmpRenamed: (n: number) => `${n} ${plural(n, 'porte', 'portent')} le nom d'un autre fichier déjà sur le PC : ${plural(n, 'il ira', 'ils iront')} en « nom (1) ».`,
  cmpExtra: (n: number) => `${n} ${plural(n, 'fichier', 'fichiers')} de ces dossiers ne ${plural(n, 'vient', 'viennent')} pas de ce téléphone (autre appareil ou copie à la main).`,
  cmpNotEncrypted: 'Ce transfert ne sera pas chiffré.',
  cmpChecked: (n: number) => `${n} ${plural(n, 'fichier vérifié', 'fichiers vérifiés')} un par un : la liste du PC était incomplète ou pas à jour.`,
  cmpFailed: (m: string) => `Comparaison impossible : ${m}`,
  cmpOffline: 'PC hors ligne : la comparaison se fera au moment de sauvegarder.',
  more: (n: number) => `+${n}`,
  custom: 'Perso…',
  periodTitle: 'Période',
  periodSub: 'Ce que tu veux sauvegarder, selon la date des photos et vidéos.',
  shortcuts: 'Raccourcis',
  lastN: (n: number) => `${n} derniers mois`,
  years: 'Une année',
  fromTo: 'De tel mois à tel mois',
  from: 'De',
  to: 'À',
  periodCount: (n: number, size: string) => `${n} ${plural(n, 'fichier', 'fichiers')} · ${size}`,
  apply: 'Valider',
  periodRow: 'Période',
  whenLabel: 'Quand',
  periods: { all: 'Tout', thisMonth: 'Ce mois-ci', lastMonth: 'Mois dernier' } as Record<'all' | 'thisMonth' | 'lastMonth', string>,
  pickMonth: 'Ou un mois précis',
  monthLabel: (m: string, y: number) => `${m} ${y}`,
  encryptTitle: 'Chiffrer les transferts',
  encryptHint: "Chiffrer coûte un peu de débit : chaque paquet est chiffré par le téléphone puis déchiffré par le PC. Le téléphone suit sans peine (2 Go/s mesurés), c'est l'échange qui s'alourdit, et avec un Mac on plafonne vers 90 Mo/s. Chez toi, sur ton propre Wi-Fi, tu peux le couper pour aller au plus vite : les fichiers restent protégés contre toute modification en route.",
  psDone: 'PixelGuard est prêt :',
  sourcesTitle: "D'où viennent les photos",
  sourcesSub: 'Choisis les albums du téléphone à sauvegarder. PixelGuard s’en souvient.',
  sources: 'Sources',
  kindsLabel: 'Quoi',
  kinds: { all: 'Photos et vidéos', photos: 'Photos', videos: 'Vidéos' } as Record<'all' | 'photos' | 'videos', string>,
  albumsLabel: 'Albums',
  sortingTitle: 'Rangement sur le PC',
  sortingSub: 'Comment tes fichiers sont classés dans le dossier partagé.',
  sortingRow: 'Rangement sur le PC',
  layouts: {
    month: ['Par mois', 'Comme PixelGuard en USB : les deux remplissent les mêmes dossiers'],
    yearMonth: ['Par année, puis par mois', 'Un dossier par année, les mois dedans'],
    year: ['Par année', 'Un dossier par année, sans sous-dossier'],
    albumMonth: ['Par album, puis par mois', 'Camera, WhatsApp, captures… chacun de son côté'],
    flat: ['Tout dans un dossier', 'Aucun classement'],
  } as Record<'month' | 'yearMonth' | 'year' | 'albumMonth' | 'flat', [string, string]>,
  splitKinds: 'Photos et vidéos à part',
  splitKindsHint: 'Ajoute un dossier Photos et un dossier Vidéos au-dessus du rangement.',
  preview: 'Aperçu avec tes derniers fichiers',
  sortingNote: 'Changer de rangement ne déplace rien sur le PC. Ce qui est déjà copié n’est pas recopié, seules les nouvelles copies suivent le nouveau rangement.',
  root: 'dossier de sauvegarde',

  albumsTitle: 'Albums',
  albumsSub: 'Ce qui part sur le PC. PixelGuard s’en souvient.',
  all: 'Tout',
  none: 'Rien',

  pcTitle: 'Ton PC',
  pcSub: 'Trouvé en quelques secondes sur ton Wi-Fi.',
  prepTitle: 'Préparer le PC (une seule fois)',
  prepText:
    "Sur le PC : touche Windows + X, ouvre « Terminal » (ou PowerShell), colle cette ligne et fais Entrée. Si Windows demande « Voulez-vous autoriser… », réponds Oui : la commande se relance d'elle-même en administrateur. Elle crée le dossier partagé PixelGuard dans Images (le même que PixelGuard en USB) et ouvre le partage de fichiers sur ton réseau privé.",
  prepManual: 'Ou à la main : clic droit sur un dossier › Propriétés › Partage › Partager.',
  copy: 'Copier',
  copied: 'Copié',
  step1: 'Choisis ton PC',
  searching: 'Recherche sur le Wi-Fi…',
  found: (n: number) => `${n} ${plural(n, 'appareil trouvé', 'appareils trouvés')}`,
  nothingFound: ios
    ? 'Aucun PC trouvé. Il est allumé, sur le même Wi-Fi, avec le dossier partagé ? Vérifie aussi que PixelGuard a accès au réseau local (Réglages › Confidentialité › Réseau local).'
    : 'Aucun PC trouvé. Il est allumé, sur le même Wi-Fi, avec le dossier partagé ?',
  rescan: 'Relancer',
  manual: 'Saisir son adresse',
  hostPh: 'DESKTOP-XXXX ou 192.168.1.20',
  step2: 'Connexion',
  user: 'Utilisateur Windows',
  userPh: 'ton nom ou ton e-mail Microsoft',
  password: 'Mot de passe Windows',
  passwordHint: "Avec un compte Microsoft, c'est son mot de passe, pas le code PIN. Il reste chiffré sur le téléphone.",
  login: 'Se connecter',
  step3: 'Dossier de sauvegarde',
  shareManual: 'Nom du dossier partagé',
  sharePh: 'PixelGuard',
  folder: 'Sous-dossier (facultatif)',
  folderPh: 'Téléphone',
  finish: "C'est parti",
  writeDenied: (share: string) => `Ce compte peut lire « ${share} » mais pas y écrire. Choisis un autre dossier partagé, ou donne-lui l'écriture sur le PC.`,
  ready: 'PC prêt',
  speedTitle: 'Test de vitesse',
  speedText: 'Envoie 128 Mo de test au PC, puis les efface.',
  speedRun: 'Lancer le test',
  speedResult: (v: string) => `${v}/s`,
  speedDetails: (dialect: string, encrypted: boolean, signed: boolean, crypto: string) =>
    `${dialect} · ${encrypted ? 'chiffré' : signed ? 'signé, pas chiffré' : 'ni chiffré ni signé'} · crypto ${crypto}`,
  encrypted: 'Chiffré : personne sur le réseau ne peut voir tes fichiers.',
  notEncrypted: "Pas chiffré : ce PC ne le permet pas (SMB 3 requis). Tes fichiers passent en clair sur le réseau, à n'utiliser que chez toi.",
  forget: 'Oublier ce PC',

  freeTitle: 'Libérer de la place',
  freeText: 'Ce qui est déjà sur le PC peut quitter le téléphone. Chaque copie est relue et comparée octet par octet avant.',
  olderThan: 'Plus vieux que',
  ages: { 0: 'Tout', 30: '1 mois', 90: '3 mois', 365: '1 an' } as Record<number, string>,
  freeCount: (n: number) => `${n} ${plural(n, 'fichier', 'fichiers')}`,
  freeNone: "Rien à libérer pour l'instant. Lance d'abord une sauvegarde.",
  freeVerify: 'Vérifier et mettre à la corbeille',
  freeDifferent: (n: number) => `${n} ${plural(n, 'fichier diffère', 'fichiers diffèrent')} sur le PC : ${plural(n, 'gardé', 'gardés')} sur le téléphone.`,
  freeDone: (n: number, size: string) =>
    ios
      ? `${n} ${plural(n, 'fichier', 'fichiers')} dans « Supprimés récemment » (${size}). Récupérables 30 jours.`
      : `${n} ${plural(n, 'fichier', 'fichiers')} à la corbeille (${size}). Récupérables 30 jours.`,
  keepOpen: "Sur iPhone, garde PixelGuard ouvert : l'écran reste allumé pendant l'envoi. Si tu changes d'appli, l'envoi s'arrête proprement et reprendra là où il en était.",
  freeRefused: 'Rien supprimé.',
};

type Dict = typeof fr;

const en: Dict = {
  demo: 'Browser demo: nothing really moves',

  permTitle: 'Your photos stay home',
  permText: 'PixelGuard copies your photos and videos to your PC over your Wi-Fi. No cloud, no account. It needs access to your gallery.',
  permButton: 'Allow access',
  permLimited: 'Partial access: PixelGuard only sees the selected photos. Allow full access in Android settings.',

  tagline: 'Your photos, on your PC.',
  safe: 'safe',
  allSafe: 'Everything is safe',
  pending: (n, size) => `${n} new · ${size}`,
  firstRun: (n, size) => `${n} files · ${size} to check`,
  noPc: 'Pick your PC',
  online: 'online',
  offline: 'offline',
  noAlbum: 'No album selected',
  albumsCount: (n) => `${n} ${plural(n, 'album', 'albums')}`,
  backupN: (n) => `Back up ${n} ${plural(n, 'file', 'files')}`,
  backup: 'Back up',
  checkAgain: 'Check again with the PC',
  stop: 'Stop',
  wifiOnly: 'Connect to your home Wi-Fi: PixelGuard only uses the local network.',
  phase: {
    connect: 'Connecting to the PC',
    scan: 'Reading the gallery',
    compare: 'What the PC already has',
    send: 'Sending',
    verify: 'Checking',
    done: 'Done',
  },
  files: (done, total) => `${done} / ${total}`,
  left: (d) => `${d} left`,
  perSecond: '/s',
  result: (up, skip, fail) => `${up} copied · ${skip} already there${fail ? ` · ${fail} failed` : ''}`,
  resultTime: (size, dur) => `${size} in ${dur}`,
  stopped: 'Stopped halfway',
  lastRun: (when) => `Last backup ${when}`,
  freeRow: 'Free up space',
  freeRowSub: (size) => `${size} already on the PC`,
  pcRow: 'PC and settings',

  onPc: 'already on the PC',
  notCompared: 'not compared yet',
  allOnPc: 'Everything is on the PC',
  toSend: (n, size) => `${n} to send · ${size}`,
  noFiles: 'No files for this period',
  comparing: 'Comparing with the PC…',
  offlineStatus: "PC offline: can't compare",
  knownOnly: 'from the last comparison',
  reviewTitle: 'To send',
  reviewSub: 'Tap a photo or video to leave it out of this backup.',
  reviewCount: (n, total, size) => `${n} of ${total} · ${size}`,
  selectAll: 'Select all',
  selectNone: 'Select none',
  noVideos: 'No videos',
  noPhotos: 'No photos',
  done: 'Done',
  choose: 'Choose',
  excludedNote: (n) => `${n} left out of this backup`,
  historyTitle: 'History',
  historySub: 'Past backups, newest first.',
  historyEmpty: 'No backup yet.',
  historySpeed: (v) => `${v}/s`,
  historyRow: (up, skip, fail) => `${up} copied · ${skip} already there${fail ? ` · ${fail} failed` : ''}`,
  pcsTitle: 'Your PCs',
  pcsSub: 'Pick where the next backup goes.',
  addPc: 'Add a PC',
  edit: 'Edit',
  active: 'Current destination',
  editPcTitle: 'New PC',
  notifTitle: 'PixelGuard backup',
  notifProgress: (done, total, speed) => `${done} / ${total} files · ${speed}/s`,
  cmpTitle: 'On the PC',
  cmpRunning: 'Comparing with the PC…',
  cmpAlready: (n, size) => `${n} already on the PC (${size})`,
  cmpMissing: (n, size) => `${n} missing · ${size}`,
  cmpNothingMissing: 'Nothing missing',
  cmpRenamed: (n) => `${n} ${plural(n, 'has', 'have')} the name of another file already on the PC: saved as "name (1)".`,
  cmpExtra: (n) => `${n} ${plural(n, 'file', 'files')} in these folders ${plural(n, "doesn't", "don't")} come from this phone (another device or copied by hand).`,
  cmpNotEncrypted: 'This transfer will not be encrypted.',
  cmpChecked: (n) => `${n} ${plural(n, 'file', 'files')} checked one by one: the PC's list was incomplete or out of date.`,
  cmpFailed: (m) => `Couldn't compare: ${m}`,
  cmpOffline: 'PC offline: the comparison will happen when you back up.',
  more: (n) => `+${n}`,
  custom: 'Custom…',
  periodTitle: 'Period',
  periodSub: 'What you want to back up, by the date of the photos and videos.',
  shortcuts: 'Shortcuts',
  lastN: (n) => `Last ${n} months`,
  years: 'A year',
  fromTo: 'From one month to another',
  from: 'From',
  to: 'To',
  periodCount: (n, size) => `${n} ${plural(n, 'file', 'files')} · ${size}`,
  apply: 'Apply',
  periodRow: 'Period',
  whenLabel: 'When',
  periods: { all: 'All', thisMonth: 'This month', lastMonth: 'Last month' },
  pickMonth: 'Or a specific month',
  monthLabel: (m, y) => `${m} ${y}`,
  encryptTitle: 'Encrypt transfers',
  encryptHint: "Encryption costs some speed: the phone encrypts every packet and the PC decrypts it. The phone keeps up easily (2 GB/s measured), the exchange just gets heavier, and with a Mac it tops out around 90 MB/s. At home, on your own Wi-Fi, you can turn it off for the fastest copies: files stay protected against any change on the way.",
  psDone: 'PixelGuard is ready:',
  sourcesTitle: 'Where photos come from',
  sourcesSub: 'Pick the phone albums to back up. PixelGuard remembers.',
  sources: 'Sources',
  kindsLabel: 'What',
  kinds: { all: 'Photos and videos', photos: 'Photos', videos: 'Videos' },
  albumsLabel: 'Albums',
  sortingTitle: 'Sorting on the PC',
  sortingSub: 'How your files are organized in the shared folder.',
  sortingRow: 'Sorting on the PC',
  layouts: {
    month: ['By month', 'Like PixelGuard over USB: both fill the same folders'],
    yearMonth: ['By year, then month', 'One folder per year, months inside'],
    year: ['By year', 'One folder per year, no subfolder'],
    albumMonth: ['By album, then month', 'Camera, WhatsApp, screenshots… each on its own'],
    flat: ['All in one folder', 'No sorting'],
  },
  splitKinds: 'Photos and videos apart',
  splitKindsHint: 'Adds a Photos folder and a Videos folder on top.',
  preview: 'Preview with your latest files',
  sortingNote: 'Changing the sorting moves nothing on the PC. What is already copied is not copied again; only new copies follow the new sorting.',
  root: 'backup folder',

  albumsTitle: 'Albums',
  albumsSub: 'What goes to the PC. PixelGuard remembers.',
  all: 'All',
  none: 'None',

  pcTitle: 'Your PC',
  pcSub: 'Found in a few seconds on your Wi-Fi.',
  prepTitle: 'Prepare the PC (once)',
  prepText:
    "On the PC: press Windows + X, open \"Terminal\" (or PowerShell), paste this line and press Enter. If Windows asks \"Do you want to allow…\", say Yes: the command restarts itself as administrator. It creates the PixelGuard shared folder in Pictures (the same one PixelGuard uses over USB) and allows file sharing on your private network.",
  prepManual: 'Or by hand: right-click a folder › Properties › Sharing › Share.',
  copy: 'Copy',
  copied: 'Copied',
  step1: 'Pick your PC',
  searching: 'Searching your Wi-Fi…',
  found: (n) => `${n} ${plural(n, 'device found', 'devices found')}`,
  nothingFound: ios
    ? 'No PC found. Is it on, on the same Wi-Fi, with the shared folder? Also check that PixelGuard may use the local network (Settings › Privacy › Local Network).'
    : 'No PC found. Is it on, on the same Wi-Fi, with the shared folder?',
  rescan: 'Search again',
  manual: 'Type its address',
  hostPh: 'DESKTOP-XXXX or 192.168.1.20',
  step2: 'Sign in',
  user: 'Windows user',
  userPh: 'your name or Microsoft e-mail',
  password: 'Windows password',
  passwordHint: 'With a Microsoft account, use its password, not the PIN. It stays encrypted on the phone.',
  login: 'Sign in',
  step3: 'Backup folder',
  shareManual: 'Shared folder name',
  sharePh: 'PixelGuard',
  folder: 'Subfolder (optional)',
  folderPh: 'Phone',
  finish: "Let's go",
  writeDenied: (share) => `This account can read "${share}" but not write to it. Pick another shared folder, or give it write access on the PC.`,
  ready: 'PC ready',
  speedTitle: 'Speed test',
  speedText: 'Sends 128 MB of test data to the PC, then deletes it.',
  speedRun: 'Run the test',
  speedResult: (v) => `${v}/s`,
  speedDetails: (dialect, encrypted, signed, crypto) =>
    `${dialect} · ${encrypted ? 'encrypted' : signed ? 'signed, not encrypted' : 'neither encrypted nor signed'} · ${crypto} crypto`,
  encrypted: 'Encrypted: nobody on the network can see your files.',
  notEncrypted: 'Not encrypted: this PC does not allow it (SMB 3 needed). Your files travel in the clear, only use this at home.',
  forget: 'Forget this PC',

  freeTitle: 'Free up space',
  freeText: 'What is already on the PC can leave the phone. Each copy is read back and compared byte by byte first.',
  olderThan: 'Older than',
  ages: { 0: 'All', 30: '1 month', 90: '3 months', 365: '1 year' },
  freeCount: (n) => `${n} ${plural(n, 'file', 'files')}`,
  freeNone: 'Nothing to free yet. Run a backup first.',
  freeVerify: 'Check and move to trash',
  freeDifferent: (n) => `${n} ${plural(n, 'file differs', 'files differ')} on the PC: kept on the phone.`,
  freeDone: (n, size) =>
    ios
      ? `${n} ${plural(n, 'file', 'files')} moved to Recently Deleted (${size}). Recoverable for 30 days.`
      : `${n} ${plural(n, 'file', 'files')} moved to trash (${size}). Recoverable for 30 days.`,
  keepOpen: 'On iPhone, keep PixelGuard open: the screen stays on during the backup. If you switch apps, the backup stops cleanly and picks up where it left off next time.',
  freeRefused: 'Nothing deleted.',
};

export const lang: Lang = getLocales()[0]?.languageCode === 'fr' ? 'fr' : 'en';
export const t: Dict = lang === 'fr' ? fr : en;

/** « il y a 2 h », « hier »... (fait main : Hermes n'a pas Intl.RelativeTimeFormat partout). */
export function ago(ms: number): string {
  const min = Math.round((Date.now() - ms) / 60000);
  const fr = lang === 'fr';
  if (min < 1) return fr ? "à l'instant" : 'just now';
  if (min < 60) return fr ? `il y a ${min} min` : `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 24) return fr ? `il y a ${h} h` : `${h} h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return fr ? 'hier' : 'yesterday';
  return fr ? `il y a ${d} jours` : `${d} days ago`;
}

const SHORT: Record<Lang, string[]> = {
  fr: ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'],
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
};

/** « oct. 2026 » : un mois écrit court (`k` vaut 202610). */
export function shortMonth(k: number): string {
  return `${SHORT[lang][(k % 100) - 1]} ${Math.floor(k / 100)}`;
}

/** Le nom à afficher d'une période : « Ce mois-ci », « 3 derniers mois », « juil. 2026 → sept. 2026 »... */
export function periodLabel(p: Period): string {
  switch (p.kind) {
    case 'all':
    case 'thisMonth':
    case 'lastMonth':
      return t.periods[p.kind];
    case 'lastMonths':
      return t.lastN(p.n);
    case 'year':
      return String(p.year);
    default: {
      const r = periodRange(p)!;
      return r[0] === r[1] ? shortMonth(r[0]) : `${shortMonth(r[0])} → ${shortMonth(r[1])}`;
    }
  }
}
