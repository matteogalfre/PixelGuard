# Audit : appairage et vitesse de transfert

Fait le 25/11/2026, avant le premier essai sur le téléphone. Les chiffres « mesuré » viennent du Mac. Ceux du téléphone restent à mesurer avec le test de vitesse intégré à l'appli (écran PC).

## Appairage : avant, après

**Avant**, il fallait taper 5 champs sans aide : adresse IP du PC, nom exact du partage, sous-dossier, utilisateur, mot de passe. Côté PC, il fallait créer le partage à la main dans les propriétés du dossier.

**Maintenant :**

| Étape | Avant | Maintenant |
|---|---|---|
| Préparer le PC | partage à la main, pare-feu à deviner | une ligne à coller dans Terminal (admin) : crée `Images\PixelGuard` partagé (le même dossier que PixelGuard en USB) et ouvre le partage de fichiers sur le réseau privé seulement |
| Trouver le PC | taper son IP | l'appli essaie le port SMB sur les 254 adresses du Wi-Fi, 64 à la fois, et affiche le nom du PC (NetBIOS, sinon DNS du routeur). Compter 1 à 2 secondes |
| Nom du partage | à taper sans faute | listé tout seul après connexion (SRVSVC NetrShareEnum, le même appel que l'Explorateur), `PixelGuard` présélectionné |
| Identifiants | 2 champs | toujours 2 champs : impossible de faire sans, rien n'est installé sur le PC |

Vérifié sur un serveur SMB de test (impacket, sur le Mac) : la liste des partages revient bien (`[PHOTOS]`), et le décodage du nom NetBIOS a été testé sur une réponse type de PC Windows.

Pas fait, et pourquoi :

- **QR code** : il faudrait un logiciel sur le PC pour l'afficher, ce qu'on a écarté.
- **WS-Discovery** (la découverte « Réseau » de Windows) : ça trouverait le PC même si NetBIOS est coupé. C'est une piste si la recherche par port rate des PC chez des utilisateurs.
- **Garder le compte Windows** : déjà fait, le mot de passe est rangé chiffré (Keystore) et on ne le redemande jamais.

## Transfert : ce qui ralentissait, ce qui change

| Point | Avant | Maintenant | Gain attendu |
|---|---|---|---|
| Écritures SMB | une écriture de 4 Mo, on attend la réponse, puis la suivante | 4 écritures de 1 Mo en vol par fichier (`writeAsync`), le Wi-Fi ne reste jamais à vide | surtout quand le Wi-Fi a de la latence (5 à 20 ms en 2,4 GHz) |
| Allers-retours par fichier | 6 (existe ?, ouverture, écriture, taille ?, renommage, fermeture) | 3 (ouverture, renommage, fermeture). Le PC confirme chaque écriture, et le renommage échoue tout seul si le nom est pris | 3 allers-retours de moins par photo, soit environ 15 ms × des milliers de photos |
| Fichiers en parallèle | 2 | 3 | les petites photos s'enchaînent sans temps mort |
| Création des dossiers | 2 allers-retours par niveau (existe ?, crée) | 1 (crée, et « existe déjà » n'est pas une erreur) | petit |
| Listing des dossiers du mois | un par un | 4 à la fois | quelques secondes sur 10 ans de photos |
| Signature SMB3 (AES-CMAC) | BouncyCastle, en Java pur | crypto du système (Conscrypt, AES matériel), BouncyCastle seulement si l'algo manque | voir plus bas |
| Wi-Fi du téléphone | économie d'énergie possible entre deux paquets | verrou `WIFI_MODE_FULL_LOW_LATENCY` pendant l'envoi | dépend du téléphone, parfois énorme |
| Vitesse affichée | moyenne depuis le début | moyenne sur 5 secondes + courbe | plus juste, pas plus rapide |

### La signature, mesurée

Windows 11 24H2 exige la signature SMB : chaque octet envoyé passe dans un AES-CMAC. Mesures en Java sur le Mac (Apple M5, JVM HotSpot) :

| Opération | Débit |
|---|---|
| Signature SMB3 AES-CMAC, BouncyCastle (avant) | 310 Mo/s |
| Signature SMB2 HMAC-SHA256, BouncyCastle | 444 Mo/s |
| MD5 (vérification avant de libérer) | 865 Mo/s |

Sur un M5, ça passe large. Sur le téléphone, du Java pur tourne plusieurs fois plus lentement, et un seul cœur signe tout : on peut tomber vers le débit d'un bon Wi-Fi 6 (60 à 120 Mo/s). La crypto du système utilise les instructions AES du processeur, donc ce plafond disparaît. Le test de vitesse dit laquelle est utilisée (« crypto système » ou « Java »).

### Vérifié sur le Mac

Sur un serveur SMB de test (impacket, en local) :

- un fichier de 7 Mo arrive identique au bit près, sans `.part` qui traîne ;
- le MD5 relu sur le PC est égal à l'original ;
- un nom déjà pris est détecté au renommage, et le `.part` est effacé ;
- l'arrêt en cours de route ne laisse rien sur le PC ;
- le test de vitesse efface son fichier.

Le débit mesuré là (90 à 118 Mo/s) ne veut rien dire pour le téléphone : c'est un serveur Python en local.

## Sécurité (audit du 25/11, corrigé le jour même)

| Point | Avant | Maintenant |
|---|---|---|
| Contenu des fichiers | signé (personne ne peut le modifier), mais lisible par qui écoute le réseau | chiffré en SMB 3 (AES) dès que le PC le permet. L'écran PC l'indique avec un cadenas, et prévient si le PC ne gère que SMB 2 (smbj continue alors en clair sans le dire) |
| Adresse du PC | n'importe laquelle, tant qu'on est en Wi-Fi | adresses locales seulement (10.x, 172.16-31.x, 192.168.x, IPv6 locales). Le nom est résolu une fois et on se connecte à cette adresse-là |
| Permissions | « afficher par-dessus les autres applis », biométrie et multicast en trop | retirées |
| Mot de passe | jamais en clair (NTLMv2), rangé dans le Keystore Android | pareil. Un mot de passe court reste devinable hors ligne par qui capte l'échange |
| Signature de l'APK | clé de test publique de React Native | à remplacer par une vraie clé avant toute publication |
| Recherche du PC | essaie le port 445 sur les 254 adresses du Wi-Fi | pareil : à la maison aucun souci, sur un réseau d'entreprise ça peut ressembler à un scan |

Au repos, l'appli n'a aucune connexion ouverte, et elle n'en ouvre aucune vers Internet.

## Crypto mesurée sur le S24+ (25/11)

Banc lancé directement sur le téléphone (Exynos 2400, ART), sur 1 Mo de données :

| Opération | Crypto du système | Java (BouncyCastle) |
|---|---|---|
| Signature SMB 3 (AES-CMAC) | 1 465 Mo/s | 233 Mo/s |
| Chiffrement SMB 3.1.1, Windows 10/11 (AES-GCM) | 2 220 Mo/s | 131 Mo/s |
| Chiffrement SMB 3.0.x, macOS (AES-CCM) | 97 Mo/s | 94 Mo/s |
| MD5 (avant de libérer) | 633 Mo/s | |

En clair :
- **Avec un PC Windows 10/11**, chiffrer ne coûte rien de mesurable : 2,2 Go/s, contre 50 à 120 Mo/s pour un bon Wi-Fi. Passer par la crypto du système fait gagner un facteur 6 à 17.
- **Avec un Mac** (SMB 3.0.2, AES-CCM), le chiffrement plafonne vers 95 Mo/s sur un cœur. Ça ne peut gêner que sur un réseau très rapide. L'option « Chiffrer les transferts » (activée par défaut) permet de le couper chez soi.
- Sur le téléphone, avec le Mac : « Chiffré » confirmé, 561 Ko/s chiffré contre 571 Ko/s avant. Même débit, puisque c'est le Wi-Fi invité qui bride.

## Premier essai réel (S24+, 25/11)

- Connexion au Mac et liste des partages : OK. Le premier essai a échoué parce que le premier partage de la liste (« Admin's Public Folder ») était en lecture seule. Corrigé : `pickShare` choisit le dossier PixelGuard, sinon le premier qui n'est pas « Public », et l'erreur explique le refus.
- Test de vitesse : 571 Ko/s en SMB 3.0.2 signé, avec la crypto du système. Le téléphone était sur le Wi-Fi invité du bureau et le Mac sur l'autre réseau : 29 ms de ping, liaison du téléphone tombée à 40 Mbit/s. C'est à refaire sur un même Wi-Fi.

## Ce qui reste le plus gros facteur

Le Wi-Fi lui-même. Dans l'ordre :

1. le PC branché en Ethernet sur la box plutôt qu'en Wi-Fi ;
2. le téléphone en 5 ou 6 GHz, près de la box ;
3. pas de répéteur entre les deux.

Le test de vitesse de l'appli permet de comparer.

## Ajouts du 25/11 (après le premier essai)

- **Écran éteint** : un service de premier plan (type `dataSync`) garde l'appli en vie avec un verrou processeur. Sa notification montre la progression et un bouton Arrêter. Ça ne va pas plus vite, mais on n'a plus à garder l'écran allumé.
- **Reprise** : un envoi coupé (Arrêter, Wi-Fi perdu) garde son `.part` s'il dépasse 8 Mo. Le téléphone note quel original l'a écrit (adresse du média, taille, date). La fois suivante, seul ce même original reprend là où il s'était arrêté, après comparaison des 64 derniers Ko. Un `.part` écrit par un autre fichier, même s'il lui ressemble, repart de zéro : le banc d'essai vérifie les deux cas.
- **Anneau** : il n'affiche plus « 0 % à l'abri » à l'aveugle. Il montre la part déjà sur le PC d'après la dernière comparaison, et « ? » tant qu'on n'a pas comparé.

## Premier essai sur un PC Windows (retours du 25/11)

- **Débit chiffré plus bas que non chiffré.** Ce n'est pas la crypto du téléphone : smbj propose AES-GCM en premier, Windows l'accepte, et le téléphone le fait à 2,2 Go/s. Le surcoût vient de l'échange lui-même : en-têtes en plus, copies de paquets, déchiffrement côté Windows. Le texte de l'appli le dit maintenant, et on peut couper le chiffrement chez soi (les fichiers restent signés).
- **Photos toujours « manquantes » après les avoir envoyées.** Hypothèse : la liste du dossier renvoyée par Windows est vide ou a des tailles périmées (NTFS met la taille à jour en différé dans la liste). Correctif : un fichier que l'index dit envoyé mais que la liste ne montre pas est vérifié directement sur le fichier (`statFiles`). Pareil avant d'envoyer un fichier en « nom (1) » parce que sa taille diffère. Pareil quand un nom est déjà pris au moment du renommage. L'accueil dit combien de fichiers ont dû être vérifiés un par un : c'est l'indice à regarder au prochain essai.
- **Commande Windows** : elle ne marchait qu'en administrateur. Elle vérifie maintenant ses droits et se relance d'elle-même via la demande de Windows. Elle peut aussi être relancée sans erreur.

## Sûreté des données (audit du 26/11, lot 1)

Six cas où une copie pouvait être fausse, perdue ou supprimée à tort, corrigés sur Android et sur iPhone.

- **Rafales iPhone.** Seule la photo choisie d'une rafale était listée, donc sauvegardée. Toutes les photos de la rafale le sont maintenant. À la suppression, une rafale n'est mise à la corbeille que si toutes ses photos ont été vérifiées sur le PC.
- **Langue des dossiers.** Les dossiers du mois suivaient la langue du téléphone : la changer faisait tout renvoyer dans « 2026 November » à côté de « 2026 Novembre ». La langue est maintenant fixée par PC (choix dans l'écran du PC), et les PC déjà enregistrés gardent celle d'aujourd'hui.
- **Deux téléphones, même nom.** Le `.part` s'ouvre en exclusif : si deux appareils envoient le même nom en même temps, le second est refusé au lieu de mélanger les deux fichiers. Pendant une sauvegarde, un fichier qui doit changer de nom (« nom (1) ») ne prend jamais un nom déjà promis à un autre envoi. Pour iPhone, libsmb2 a reçu un petit ajout (voir `modules/pgnative/ios/libsmb2/PIXELGUARD-PATCHES.md`). Le serveur du banc d'essai n'applique pas les verrous de partage : le refus se vérifiera sur Windows.
- **Reprise sans trou.** Les 4 dernières écritures d'un envoi coupé pouvaient être perdues alors qu'une suivante était arrivée, laissant un trou de zéros que la reprise ne voyait pas (elle ne contrôlait que la fin). La reprise repart maintenant 4 Mo avant la fin du `.part`, ce qui a forcément été confirmé, et réécrit tout le reste. Le banc d'essai le vérifie sur Android et sur iPhone avec un `.part` troué.
- **Index des copies.** Deux enregistrements pouvaient s'écraser (comparaison et sauvegarde en même temps), et un fichier illisible repartait à vide. Chaque changement s'applique maintenant sur la dernière version enregistrée, un par un, et un index illisible est mis de côté au lieu d'être écrasé.
- **Après une suppression sur iPhone.** Une photo dont un fichier n'avait pas été vérifié (Live Photo, rafale incomplète) reste sur le téléphone, mais l'index la croyait partie. Seul ce qui a vraiment été supprimé sort de l'index, et l'écran dit combien de photos ont été gardées.

## Fiabilité (audit du 26/11, lot 2)

- **Connexion fermée sous les pieds.** Chaque comparaison refermait le partage, et les envois en cours tombaient. Le partage déjà ouvert est maintenant gardé. Quand un envoi perd sa connexion, Android ne ferme plus que celle-là, jamais celle qu'un autre envoi vient de rouvrir.
- **Un nouvel essai sur coupure.** Une opération qui tombe en « connexion perdue » est retentée une fois, sur une connexion neuve (pas après Arrêter, pas sur un refus du PC). Un envoi repris ainsi repart de son `.part`. Limite : juste après une coupure Wi-Fi, le PC peut garder l'ancien `.part` ouvert quelques instants ; ce fichier-là est alors remis à la sauvegarde suivante, avec un message qui le dit.
- **Connexion morte prise pour vivante.** Windows ferme une session restée 15 min sans rien faire. Sur iPhone, le socket est maintenant regardé avant chaque usage, et une connexion fermée par le PC est remplacée avant de servir. Sur Android, smbj ne le voit pas du tout (`isConnected` reste vrai) : un aller-retour de contrôle, au moment de se connecter, le dit et échoue tout de suite dans ce cas. Une session expirée compte comme une coupure sur les deux. Les deux bancs le vérifient avec un second serveur qu'on arrête.
- **Comparaison périmée.** Changer d'album ou de période pendant une comparaison pouvait afficher le résultat de l'ancienne sélection. Une comparaison dont la sélection a changé est maintenant ignorée et relancée.
- **Écran éteint (Android).** Le service démarre avant la connexion, et couvre aussi la vérification de « Libérer de la place ». À la limite de 6 h par jour d'Android 15, il s'arrête proprement (sinon Android ferme l'appli) et la sauvegarde dit pourquoi elle s'est arrêtée. Si Android refuse de le démarrer, la sauvegarde continue appli ouverte.
- **« Revérifier avec le PC »** relance une comparaison, plus une sauvegarde. Une sauvegarde qui n'a rien envoyé n'ajoute plus de ligne vide à l'historique.

## Sécurité (audit du 26/11, lot 3)

- **Plus de repli silencieux sans chiffrement.** iPhone refaisait la connexion sans chiffrer si la connexion chiffrée échouait, pour n'importe quelle raison ; smbj (Android) continue simplement signé si le PC ne chiffre pas. Désormais, à l'appairage, un PC qui ne sait pas chiffrer est dit tel quel et le réglage se coupe sous tes yeux. Ensuite, chiffrement demandé veut dire chiffrement ou rien : la sauvegarde s'arrête avec un message, rien n'est envoyé.
- **Le PC est reconnu avant le mot de passe.** L'identifiant SMB du serveur (ServerGuid) ne marche pas : Windows en change à chaque démarrage. Le PC annonce en revanche son nom NetBIOS dans le défi NTLM, qui arrive avant que le téléphone envoie l'utilisateur et la réponse au mot de passe. Ce nom est retenu à l'appairage (ou à la première connexion pour un PC déjà enregistré), puis contrôlé à chaque connexion. Un autre nom arrête tout avant la réponse. Android enveloppe l'authentificateur NTLM de smbj ; iPhone a un petit ajout dans libsmb2 (voir `PIXELGUARD-PATCHES.md`). Les deux bancs le vérifient (même nom accepté, autre nom refusé). Limite : un nom n'est pas un secret, un appareil préparé exprès pourrait l'imiter ; ça protège du cas courant (même adresse, autre réseau). Si tu renommes ton PC, il faut refaire l'appairage.
- Du coup la comparaison automatique sur un réseau inconnu ne fuit plus rien : elle s'arrête au défi NTLM.

## Performance et taille (audit du 26/11, lot 4)

- **APK** (103 Mo, dont 51 Mo de code Java/Kotlin non réduit et deux architectures) : R8 et la réduction des ressources sont activés, avec des règles qui gardent smbj et sa messagerie interne (mbassador, qui passe par la réflexion) ; BouncyCastle peut être réduit, smbj l'appelle sans réflexion. `@expo/ui` (Jetpack Compose, 7 Mo) n'est plus lié : il vient d'expo-router pour une barre d'outils que l'appli n'affiche pas, et ses vues ne se chargent qu'à l'affichage. Bibliothèques natives compressées dans l'APK. Les deux architectures (64 et 32 bits) restent, imposées par le profil `apk` d'eas.json : les vieux téléphones gardent l'appli. Résultat au build de la 0.3.0 : **36 Mo au lieu de 103**, smbj, sa messagerie interne et ZXing gardés (vérifié dans l'APK), ni ML Kit ni expo-camera côté Android.
- **Galerie** : elle n'est plus relue à chaque retour sur l'accueil. Android donne un compteur de changements (MediaStore), iPhone prévient à chaque changement (PhotoKit) : tant qu'il ne bouge pas, l'appli garde sa copie. Elle est aussi oubliée au retour dans l'appli et quand l'accès aux photos change.
- **Index des copies** : gardé en mémoire (plus besoin de relire et décoder le fichier à chaque changement), et écrit toutes les 200 copies ou 20 s pendant une sauvegarde, sans faire attendre l'envoi suivant.
- **Vérification une par une** : par lots de 200, avec l'avancement à l'écran, et Arrêter est pris en compte entre deux lots.
- **Écran** : il ne se redessine plus à chaque petite photo envoyée ou vérifiée, quatre fois par seconde au plus.

## Expérience (audit du 26/11, lot 5)

- **Permissions** : un accès aux photos refusé pour de bon (Android ou iOS ne redemandent plus) affiche « Ouvrir les réglages », et l'appli relit l'accès au retour. Un accès partiel est dit sur l'accueil, avec « Choisir d'autres photos » qui ouvre la fenêtre du système.
- **Erreurs** : traduites d'après leur code, dans la langue du téléphone, sans « STATUS_… » brut quand on sait dire mieux (accès refusé, disque plein, mauvais mot de passe, dossier partagé introuvable). Dans l'appairage, elles s'affichent dans l'étape en cours au lieu de tout en bas.
- **Fin de l'appairage** : un bouton « Passer à la sauvegarde ». « Oublier ce PC » demande confirmation et dit que rien n'est effacé sur le PC.
- **Accessibilité** : chaque bouton a un nom et un rôle pour le lecteur d'écran (cases à cocher, choix exclusifs, état coché ou replié). Les textes pâles passent à un contraste de 5:1. Les petites cibles font au moins 44 points. Les boutons et les champs grandissent avec une grande taille de texte au lieu de couper, et les chiffres dans les anneaux sont plafonnés pour ne pas déborder. Deux boutons imbriqués (Copier dans la carte de préparation, Modifier dans la ligne d'un PC) sont séparés : le lecteur d'écran n'atteignait pas celui de l'intérieur. Contrôlé sur tous les écrans de l'aperçu web : aucun bouton sans nom, aucun bouton dans un bouton.
- **Premier essai** :
  - la commande Windows prévient si le réseau est en « Public », et affiche le nom d'utilisateur à taper ;
  - quand aucun PC n'est trouvé, une aide repliée explique le réseau « Privé » de Windows, le « Partage de fichiers Windows » du Mac et comment trouver l'adresse du PC ;
  - le texte du mot de passe dit quoi faire avec un compte Microsoft, y compris sans mot de passe (Windows Hello seul) ;
  - avant une grosse sauvegarde, l'accueil donne une durée estimée (d'après le débit médian des sauvegardes passées, sinon 25 Mo/s) et, au-delà de 30 min, un conseil (brancher le téléphone).

## Pistes pour plus tard

- **Lecture en flux pour la vérification** : relire la copie en parallèle de la lecture locale (aujourd'hui c'est l'une après l'autre).
- **SMB multicanal** : smbj ne le gère pas.
- **Compression SMB** : inutile, photos et vidéos sont déjà compressées.
