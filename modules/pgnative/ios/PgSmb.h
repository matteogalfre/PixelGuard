// Le cœur SMB de PixelGuard sur iPhone, en C au-dessus de libsmb2 : le même travail que
// SmbCore.java côté Android (envoi en flux continu, reprise d'un « .part », renommage sans
// écraser, MD5 relu, liste des partages, nom NetBIOS). Testable sur le Mac sans iPhone.
#ifndef PG_SMB_H
#define PG_SMB_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct pgs_conn pgs_conn;

/** Codes renvoyés, traduits en messages et en codes JS par le module Swift. */
enum {
  PGS_OK = 0,
  PGS_UNREACHABLE = 1,
  PGS_AUTH = 2,
  PGS_SHARE = 3,
  PGS_SMB = 4,        // refus du PC, le statut NT est dans le message
  PGS_CONNECTION = 5, // connexion perdue
  PGS_TRANSFER = 6,   // lecture locale ratée, copie incomplète
  PGS_EXISTS = 7,     // nom déjà pris au renommage
  PGS_CANCELLED = 8,
  PGS_NOT_FOUND = 9,
};

/** 1 Mo par écriture SMB (moins si le PC l'impose), 4 écritures en vol par fichier. */
#define PGS_CHUNK (1 << 20)
#define PGS_DEPTH 4
/** En dessous de 8 Mo, recommencer coûte moins que vérifier la reprise. */
#define PGS_RESUME_MIN (8LL << 20)

typedef struct {
  uint16_t dialect; // 0x0202, 0x0210, 0x0300, 0x0302, 0x0311
  int sign;         // messages signés (ou chiffrés, ce qui vaut mieux)
  int seal;         // contenu chiffré en SMB 3
  uint32_t max_write;
  uint32_t max_read;
} pgs_info;

/**
 * Connexion à `share` (« IPC$ » pour lister les partages). `server` est déjà une adresse IP,
 * avec son port : « 192.168.1.20:445 » ou « [fe80::1]:445 ». `encrypt` : chiffrement SMB 3 si
 * le PC le permet, sinon on continue signé et `seal` vaut 0.
 */
int pgs_connect(const char *server, const char *share, const char *domain, const char *user,
                const char *password, int encrypt, pgs_conn **out, char *err, size_t errlen);
void pgs_close(pgs_conn *c);
/** La connexion tient encore (pas de coupure vue). */
int pgs_alive(pgs_conn *c);
void pgs_get_info(pgs_conn *c, pgs_info *info);
const char *pgs_dialect_name(uint16_t dialect);

typedef void (*pgs_name_cb)(void *ctx, const char *name);
/** Les dossiers partagés visibles (sans C$, ADMIN$, IPC$...). Connexion à IPC$. */
int pgs_list_shares(pgs_conn *c, pgs_name_cb cb, void *ctx, char *err, size_t errlen);

typedef void (*pgs_entry_cb)(void *ctx, const char *name, uint64_t size, int dir);
/** Contenu d'un dossier (vide s'il n'existe pas encore). */
int pgs_list(pgs_conn *c, const char *dir, pgs_entry_cb cb, void *ctx, char *err, size_t errlen);
/**
 * Taille lue sur le fichier lui-même, pas dans la liste du dossier (Windows peut y montrer une
 * taille pas encore à jour, ou une liste incomplète). `*size` vaut -1 s'il n'existe pas.
 */
int pgs_stat(pgs_conn *c, const char *path, int64_t *size, char *err, size_t errlen);
/** Crée chaque niveau sans demander avant s'il existe. */
int pgs_mkdirs(pgs_conn *c, const char *dir, char *err, size_t errlen);
/** Écrit puis efface « dir/.pixelguard-test ». */
int pgs_test_write(pgs_conn *c, const char *dir, char *err, size_t errlen);

/** La source d'un envoi : il faut pouvoir la rouvrir et la relire depuis le début. */
typedef struct {
  void *ctx;
  int (*open)(void *ctx);                           // 0 si ok
  int (*read)(void *ctx, uint8_t *buf, int max);    // octets lus, 0 à la fin, <0 en cas d'erreur
  void (*close)(void *ctx);
  void (*progress)(void *ctx, int64_t done);        // octets confirmés par le PC
  int (*cancelled)(void *ctx);
} pgs_source;

/**
 * Écrit la source sous « target.part » avec PGS_DEPTH écritures en vol, puis renomme en
 * « target » sans écraser (PGS_EXISTS si le nom est pris). Si `may_resume` (le téléphone sait
 * que ce « .part » vient de ce même original), un envoi coupé reprend là où il s'était arrêté,
 * après contrôle de ses 64 derniers Ko. Si `keep` vaut 0, le fichier est effacé à la fin (test
 * de vitesse). `sent` reçoit la taille écrite.
 */
int pgs_upload(pgs_conn *c, pgs_source *src, const char *target, int64_t expected, int keep,
               int may_resume, int64_t *sent, char *err, size_t errlen);

/**
 * MD5 de la copie du PC (32 caractères hexadécimaux dans `out`). Si la copie n'a pas `size`
 * octets, `out` vaut « taille:N » ou « court:N ». PGS_NOT_FOUND si elle n'existe pas.
 */
int pgs_md5_remote(pgs_conn *c, const char *path, int64_t size, int (*cancelled)(void *),
                   void *ctx, char out[64], char *err, size_t errlen);

/** Requête NetBIOS « node status » (50 octets) : le PC répond avec son nom. */
size_t pgs_nbstat_query(uint8_t buf[50], uint16_t txid);
/** Le nom de machine dans la réponse (0 si trouvé). */
int pgs_nbstat_name(const uint8_t *buf, int len, char *out, size_t outlen);

#ifdef __cplusplus
}
#endif

#endif
