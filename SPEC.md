# PixelGuard pour Android : spec courte

## Le besoin

Sauvegarder les photos et vidéos du téléphone sur le PC, sans câble, sans ADB, sans cloud et sans compte. Tout se règle depuis le téléphone, le PC n'a qu'à être allumé.

Choix faits le 25/11/2026 :

- PC fixe Windows, souvent allumé, sur le même Wi-Fi que le téléphone
- appli publique et open source, comme PixelGuard
- sauvegarde lancée à la main (j'ouvre l'appli, j'appuie)
- albums choisis une fois (Camera, WhatsApp, captures...), l'appli s'en souvient
- dossier fixe sur le PC, rangé en sous-dossiers par mois comme PixelGuard
- après une copie vérifiée, l'appli propose de libérer de la place sur le téléphone
- rien à installer sur le PC : un dossier partagé Windows (SMB) suffit
- en Wi-Fi, SMB va aussi vite que le reste, c'est le Wi-Fi qui plafonne

## Côté PC

Un dossier partagé Windows, à créer une fois. L'appli donne une ligne à coller dans Terminal (admin) : elle crée `Images\PixelGuard` (le même dossier que PixelGuard en USB), le partage pour le compte courant et ouvre le partage de fichiers sur le réseau privé seulement. Ça se fait aussi à la main (clic droit sur le dossier › Propriétés › Partage). L'appli s'y connecte avec le compte Windows (pour un compte Microsoft : l'e-mail et son mot de passe, pas le PIN).

## Côté téléphone

Appli Expo (React Native), Android seulement pour l'instant.

Une interface sombre, une seule action principale, en français ou en anglais selon le téléphone.

1. **Accueil** : un anneau montre la part des albums choisis déjà à l'abri sur le PC, avec « 142 nouveaux · 1,2 Go ». Ça se calcule sans réseau, d'après les sauvegardes passées. En dessous : le PC (en ligne ou non) et les albums, puis le bouton « Sauvegarder 142 fichiers ». Pendant l'envoi : l'anneau suit la progression, avec la vitesse sur les 5 dernières secondes et sa courbe, le temps restant, la vignette de chaque photo en cours, et un bouton Arrêter.
2. **Ton PC** : la ligne à coller sur le PC, puis trois étapes. On choisit le PC parmi ceux trouvés sur le Wi-Fi (ou on tape son adresse), on se connecte, et on choisit le dossier partagé dans la liste. Un test écrit puis efface un fichier. Ensuite il y a un test de vitesse (128 Mo envoyés puis effacés). Le mot de passe est rangé chiffré (expo-secure-store).
3. **Albums** : une grille avec la couverture de chaque album, son nombre de fichiers et sa taille. On coche ce qu'on veut, Camera est coché au départ.
4. **Libérer de la place** : choix de l'ancienneté (tout, 1 mois, 3 mois, 1 an) et place récupérable. L'appli relit chaque copie sur le PC et la compare octet par octet (MD5) à l'original. Seuls les fichiers identiques partent : Android demande lui-même la confirmation, puis les met à la corbeille.

## Règles reprises de PixelGuard

- Dossier du mois : `2026 Novembre` en français, `2026 November` en anglais, exactement comme PixelGuard. Les copies par USB et par Wi-Fi tombent donc dans les mêmes dossiers.
- Le mois vient du nom du fichier (`20261125_...`, `IMG_2026...`, `PXL_...`, `IMG-...-WA...`), sinon de la date de prise de vue.
- Même nom et même taille dans le dossier du mois : déjà copié, on saute.
- Même nom mais taille différente : autre fichier, on l'enregistre en `nom (1).jpg`.
- Copie sous `nom.part`, renommée seulement quand elle est complète et à la bonne taille. Un transfert coupé ne laisse jamais un faux fichier fini.

## Sécurité et réseau

- Réseau local seulement : la sauvegarde ne part que sur un Wi-Fi.
- SMB 2 ou 3 avec signature, comme l'exige Windows 11. Pas de SMB 1.
- L'appli demande l'accès à la position des médias, sinon Android retire le GPS des photos qu'elle lit.

## Technique

- Module natif local `modules/pgnative` :
  - `SmbCore.java` : le cœur SMB en Java pur, testé sur un ordinateur contre un serveur SMB de test. Il gère l'envoi en flux continu (4 écritures en vol), la relecture MD5, la liste des partages (SRVSVC) et le nom NetBIOS.
  - `HybridSecurityProvider.java` : la crypto du système d'abord, BouncyCastle en secours.
  - `PgNativeModule.kt` : la galerie (MediaStore), la découverte des PC du Wi-Fi, le verrou Wi-Fi basse latence et la corbeille Android.
- smbj 0.15 (Apache-2.0) pour SMB 2/3.
- Écrans avec Expo Router (`src/app`), anneau et courbe en SVG, vignettes avec expo-image, police Inter.
- Le détail des choix de vitesse est dans [AUDIT.md](AUDIT.md).
- La logique pure (mois, noms, doublons) est en TypeScript sans dépendance, testée avec `node --test`.
- Build APK en local (prebuild + gradlew), seulement sur demande.

## Plus tard, pas dans le prototype

- sauvegarde en arrière-plan avec notification (service de premier plan)
- choix entre corbeille et suppression définitive
- traductions au-delà du français et de l'anglais
