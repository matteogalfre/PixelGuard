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

## Pistes pour plus tard

- **Lecture en flux pour la vérification** : relire la copie en parallèle de la lecture locale (aujourd'hui c'est l'une après l'autre).
- **SMB multicanal** : smbj ne le gère pas.
- **Compression SMB** : inutile, photos et vidéos sont déjà compressées.
