// Le cœur SMB de PixelGuard sur iPhone : voir PgSmb.h. Même logique que SmbCore.java.
#include "PgSmb.h"

#ifndef HAVE_CONFIG_H
#define HAVE_CONFIG_H 1
#endif
#include "config.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#include "smb2.h"
#include "libsmb2.h"
#include "libsmb2-raw.h"
#include "libsmb2-share-enum.h"
#include "libsmb2-private.h"
#include "md5.h"

struct pgs_conn {
  struct smb2_context *smb2;
  int dead;
};

static void seterr(char *err, size_t errlen, const char *fmt, ...) {
  if (err == NULL || errlen == 0) return;
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(err, errlen, fmt, ap);
  va_end(ap);
}

static int sock_ok(struct smb2_context *smb2) { return smb2 != NULL && smb2_get_fd(smb2) >= 0; }

/** Ferme tout de suite : plus aucun rappel de libsmb2 ne touchera nos tampons après ça. */
static void kill_conn(pgs_conn *c) {
  if (c->smb2 != NULL) {
    smb2_destroy_context(c->smb2);
    c->smb2 = NULL;
  }
  c->dead = 1;
}

static void clear_status(pgs_conn *c) {
  if (c->smb2 != NULL) c->smb2->nterror = 0;
}

static int not_found(uint32_t st) {
  return st == SMB2_STATUS_OBJECT_NAME_NOT_FOUND || st == SMB2_STATUS_OBJECT_PATH_NOT_FOUND ||
         st == SMB2_STATUS_NO_SUCH_FILE || st == SMB2_STATUS_NOT_FOUND;
}

/** Traduit l'échec d'un appel : coupure réseau (on ferme) ou refus du PC (statut NT). */
#define PGS_STATUS_NETWORK_SESSION_EXPIRED 0xC000035C

static int fail(pgs_conn *c, int rc, char *err, size_t errlen) {
  struct smb2_context *smb2 = c->smb2;
  if (smb2 == NULL || c->dead) {
    seterr(err, errlen, "Connexion au PC perdue");
    return PGS_CONNECTION;
  }
  uint32_t st = (uint32_t)smb2_get_nterror(smb2);
  // Session fermée par le PC (inactivité, redémarrage du service) : c'est une coupure aussi.
  if (!sock_ok(smb2) || rc == -ETIMEDOUT || rc == -ECONNRESET || rc == -EPIPE || rc == -ENOTCONN ||
      st == SMB2_STATUS_SHUTDOWN || st == SMB2_STATUS_CANCELLED || st == SMB2_STATUS_USER_SESSION_DELETED ||
      st == SMB2_STATUS_NETWORK_NAME_DELETED || st == PGS_STATUS_NETWORK_SESSION_EXPIRED ||
      // Le PC ne répond plus (délai de libsmb2 ou le nôtre) : une coupure, pas un refus. La
      // réponse peut encore arriver plus tard, la connexion ne doit plus servir.
      st == SMB2_STATUS_IO_TIMEOUT) {
    seterr(err, errlen, "Connexion au PC perdue (%s)", smb2_get_error(smb2));
    kill_conn(c);
    return PGS_CONNECTION;
  }
  if (st != 0) {
    seterr(err, errlen, "Le PC refuse : %s", nterror_to_str(st));
  } else {
    seterr(err, errlen, "Le PC refuse : %s", smb2_get_error(smb2));
  }
  return PGS_SMB;
}

/** « a/b/c » ou « \a\b\ » donnent « a\b\c ». */
static char *norm(const char *path) {
  const char *p = path ? path : "";
  while (*p == '/' || *p == '\\') p++;
  char *out = strdup(p);
  if (out == NULL) return NULL;
  for (char *q = out; *q; q++) {
    if (*q == '/') *q = '\\';
  }
  size_t n = strlen(out);
  while (n > 0 && out[n - 1] == '\\') out[--n] = 0;
  return out;
}

const char *pgs_dialect_name(uint16_t d) {
  switch (d) {
    case SMB2_VERSION_0202: return "SMB_2_0_2";
    case SMB2_VERSION_0210: return "SMB_2_1";
    case SMB2_VERSION_0300: return "SMB_3_0";
    case SMB2_VERSION_0302: return "SMB_3_0_2";
    case SMB2_VERSION_0311: return "SMB_3_1_1";
    default: return "SMB_?";
  }
}

// ------------------------------------------------------------------ Connexion

// Un PC qui coupe pendant une écriture enverrait SIGPIPE, qui tue l'appli : on l'ignore.
static void ignore_sigpipe(void) { signal(SIGPIPE, SIG_IGN); }

int pgs_connect(const char *server, const char *share, const char *domain, const char *user,
                const char *password, int encrypt, pgs_conn **out, char *err, size_t errlen) {
  return pgs_connect2(server, share, domain, user, password, encrypt ? PGS_SEAL_IF_POSSIBLE : PGS_SEAL_NO, NULL,
                      NULL, 0, out, err, errlen);
}

int pgs_connect2(const char *server, const char *share, const char *domain, const char *user,
                 const char *password, int want_seal, const char *expected_name, char *seen, size_t seenlen,
                 pgs_conn **out, char *err, size_t errlen) {
  static pthread_once_t once = PTHREAD_ONCE_INIT;
  pthread_once(&once, ignore_sigpipe);
  *out = NULL;
  if (seen != NULL && seenlen > 0) seen[0] = 0;
  int guest = user == NULL || *user == 0;
  for (int attempt = 0; attempt < 2; attempt++) {
    int seal = want_seal != PGS_SEAL_NO && attempt == 0;
    if (attempt == 1 && want_seal != PGS_SEAL_IF_POSSIBLE) break;
    struct smb2_context *smb2 = smb2_init_context();
    if (smb2 == NULL) {
      seterr(err, errlen, "Mémoire insuffisante");
      return PGS_CONNECTION;
    }
    smb2_set_version(smb2, SMB2_VERSION_ANY); // 2.0.2 à 3.1.1, jamais SMB 1
    smb2_set_timeout(smb2, 60);
    smb2_set_authentication(smb2, SMB2_SEC_NTLMSSP);
    smb2_set_user(smb2, guest ? "Guest" : user);
    smb2_set_password(smb2, guest ? "" : (password ? password : ""));
    if (domain != NULL && *domain) smb2_set_domain(smb2, domain);
    smb2_set_security_mode(smb2, SMB2_NEGOTIATE_SIGNING_ENABLED);
    // Signature exigée (Windows 11 l'exige aussi) ; un invité n'a pas de clé pour signer.
    // Avec sign à 1, libsmb2 annonce « signature requise », refuse un PC qui ne signe pas, une
    // réponse de session non signée (donc un passage en invité) et tout message non signé ou mal
    // signé ensuite. Seul le chiffrement SMB 3, qui protège mieux, la remplace.
    smb2_set_sign(smb2, guest ? 0 : 1);
    smb2_set_seal(smb2, seal);
    smb2_pg_set_expected_server_name(smb2, expected_name);
    int rc = smb2_connect_share(smb2, server, share, NULL);
    if (seen != NULL && seenlen > 0 && smb2_pg_get_server_name(smb2)[0]) {
      snprintf(seen, seenlen, "%s", smb2_pg_get_server_name(smb2));
    }
    if (rc == 0 && want_seal == PGS_SEAL_MUST && !smb2->seal) {
      // Jamais de repli silencieux : chiffrement demandé, chiffrement ou rien.
      smb2_disconnect_share(smb2);
      smb2_destroy_context(smb2);
      seterr(err, errlen, "Ce PC n'a pas accepté le chiffrement");
      return PGS_NOT_ENCRYPTED;
    }
    if (rc == 0) {
      pgs_conn *c = calloc(1, sizeof(*c));
      if (c == NULL) {
        smb2_destroy_context(smb2);
        seterr(err, errlen, "Mémoire insuffisante");
        return PGS_CONNECTION;
      }
      c->smb2 = smb2;
      *out = c;
      return PGS_OK;
    }
    const char *msg = smb2_get_error(smb2);
    uint32_t st = (uint32_t)smb2_get_nterror(smb2);
    uint16_t dialect = smb2_get_dialect(smb2);
    int code;
    if (smb2_pg_name_mismatch(smb2)) {
      seterr(err, errlen, "%s", smb2_pg_get_server_name(smb2));
      smb2_destroy_context(smb2);
      return PGS_PC_CHANGED;
    }
    // Le PC refuse vraiment le chiffrement : il le dit, ou il ne parle que SMB 2.
    int seal_refused = seal && (strstr(msg, "ncryption") != NULL || (dialect != 0 && dialect < SMB2_VERSION_0300));
    if (seal_refused && want_seal == PGS_SEAL_MUST) {
      seterr(err, errlen, "%s", msg);
      smb2_destroy_context(smb2);
      return PGS_NOT_ENCRYPTED;
    }
    if (strstr(msg, "Session setup failed") != NULL || st == SMB2_STATUS_LOGON_FAILURE ||
        st == SMB2_STATUS_ACCOUNT_DISABLED || st == SMB2_STATUS_ACCOUNT_RESTRICTION ||
        st == SMB2_STATUS_PASSWORD_EXPIRED || st == SMB2_STATUS_ACCOUNT_LOCKED_OUT) {
      code = PGS_AUTH;
    } else if (strstr(msg, "Tree Connect failed") != NULL) {
      code = PGS_SHARE;
    } else if (dialect == 0) {
      code = PGS_UNREACHABLE; // le PC n'a même pas négocié
    } else {
      code = PGS_SMB;
    }
    seterr(err, errlen, "%s", msg);
    smb2_destroy_context(smb2);
    // Appairage : seulement si le PC refuse vraiment le chiffrement (SMB 2 seulement, ou refus
    // dit), on refait sans, signé, et l'écran le dit. Tout autre échec est rendu tel quel : une
    // coupure ou un refus ne doit pas faire passer la connexion en clair. Ailleurs
    // (PGS_SEAL_MUST), la boucle s'arrête là.
    if (seal_refused && want_seal == PGS_SEAL_IF_POSSIBLE && code != PGS_AUTH) continue;
    return code;
  }
  return PGS_SMB;
}

void pgs_close(pgs_conn *c) {
  if (c == NULL) return;
  if (c->smb2 != NULL) {
    if (!c->dead && sock_ok(c->smb2)) smb2_disconnect_share(c->smb2);
    smb2_destroy_context(c->smb2);
  }
  free(c);
}

/**
 * Le PC ferme une session restée sans rien faire (15 min sous Windows) : le socket est alors
 * fermé de son côté, mais on ne le voit qu'en le regardant. Une connexion au repos ne doit rien
 * avoir à lire : si le socket dit « fin » ou « erreur », elle est morte.
 */
static int peer_closed(struct smb2_context *smb2) {
  int fd = smb2_get_fd(smb2);
  if (fd < 0) return 1;
  struct pollfd p = {.fd = fd, .events = POLLIN};
  int n = poll(&p, 1, 0);
  if (n < 0) return errno != EINTR;
  if (n == 0) return 0;
  if (p.revents & (POLLERR | POLLHUP | POLLNVAL)) return 1;
  if (p.revents & POLLIN) {
    char b;
    ssize_t r = recv(fd, &b, 1, MSG_PEEK | MSG_DONTWAIT);
    if (r == 0) return 1;
    if (r < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) return 1;
  }
  return 0;
}

int pgs_alive(pgs_conn *c) {
  if (c == NULL || c->dead || !sock_ok(c->smb2)) return 0;
  if (peer_closed(c->smb2)) {
    kill_conn(c);
    return 0;
  }
  return 1;
}

void pgs_get_info(pgs_conn *c, pgs_info *info) {
  memset(info, 0, sizeof(*info));
  if (c == NULL || c->smb2 == NULL) return;
  info->dialect = smb2_get_dialect(c->smb2);
  info->seal = c->smb2->seal ? 1 : 0;
  info->sign = (c->smb2->sign || c->smb2->seal) ? 1 : 0;
  info->max_write = smb2_get_max_write_size(c->smb2);
  info->max_read = smb2_get_max_read_size(c->smb2);
}

// ------------------------------------------------------------------ Dossiers

int pgs_list_shares(pgs_conn *c, pgs_name_cb cb, void *ctx, char *err, size_t errlen) {
  if (!pgs_alive(c)) return fail(c, -ENOTCONN, err, errlen);
  clear_status(c);
  struct smb2_share_enum_reply *rep = smb2_share_enum_sync(c->smb2, SMB2_SHARE_INFO_1);
  if (rep == NULL) return fail(c, -EIO, err, errlen);
  for (uint32_t i = 0; i < rep->entries_read; i++) {
    const char *name = rep->share_info.info_1[i].netname;
    uint32_t type = rep->share_info.info_1[i].type;
    int disk = (type & 0xff) == SMB2_SHARE_TYPE_DISKTREE;
    int special = (type & SMB2_SHARE_TYPE_HIDDEN) != 0;
    size_t n = name ? strlen(name) : 0;
    if (disk && !special && n > 0 && name[n - 1] != '$') cb(ctx, name);
  }
  smb2_free_data(c->smb2, rep);
  return PGS_OK;
}

int pgs_list(pgs_conn *c, const char *dir, pgs_entry_cb cb, void *ctx, char *err, size_t errlen) {
  if (!pgs_alive(c)) return fail(c, -ENOTCONN, err, errlen);
  char *p = norm(dir);
  if (p == NULL) return fail(c, -ENOMEM, err, errlen);
  clear_status(c);
  struct smb2dir *d = smb2_opendir(c->smb2, p);
  free(p);
  if (d == NULL) {
    if (not_found((uint32_t)smb2_get_nterror(c->smb2))) return PGS_OK; // pas encore créé
    return fail(c, -EIO, err, errlen);
  }
  struct smb2dirent *e;
  while ((e = smb2_readdir(c->smb2, d)) != NULL) {
    if (strcmp(e->name, ".") == 0 || strcmp(e->name, "..") == 0) continue;
    cb(ctx, e->name, e->st.smb2_size, e->st.smb2_type == SMB2_TYPE_DIRECTORY);
  }
  smb2_closedir(c->smb2, d);
  return PGS_OK;
}

int pgs_stat(pgs_conn *c, const char *path, int64_t *size, char *err, size_t errlen) {
  *size = -1;
  if (!pgs_alive(c)) return fail(c, -ENOTCONN, err, errlen);
  char *p = norm(path);
  if (p == NULL) return fail(c, -ENOMEM, err, errlen);
  clear_status(c);
  struct smb2_stat_64 st;
  int rc = smb2_stat(c->smb2, p, &st);
  free(p);
  if (rc < 0) {
    if (not_found((uint32_t)smb2_get_nterror(c->smb2))) return PGS_OK; // absent : -1
    return fail(c, rc, err, errlen);
  }
  *size = (int64_t)st.smb2_size;
  return PGS_OK;
}

int pgs_mkdirs(pgs_conn *c, const char *dir, char *err, size_t errlen) {
  if (!pgs_alive(c)) return fail(c, -ENOTCONN, err, errlen);
  char *p = norm(dir);
  if (p == NULL) return fail(c, -ENOMEM, err, errlen);
  int result = PGS_OK;
  for (char *q = p;; q++) {
    if (*q != '\\' && *q != 0) continue;
    char saved = *q;
    *q = 0;
    if (*p) {
      clear_status(c);
      int rc = smb2_mkdir(c->smb2, p);
      uint32_t st = (uint32_t)smb2_get_nterror(c->smb2);
      if (rc < 0 && st != SMB2_STATUS_OBJECT_NAME_COLLISION && rc != -EEXIST) {
        result = fail(c, rc, err, errlen);
        break;
      }
    }
    *q = saved;
    if (saved == 0) break;
  }
  free(p);
  return result;
}

static char *join(const char *dir, const char *name) {
  char *d = norm(dir);
  if (d == NULL) return NULL;
  size_t n = strlen(d) + strlen(name) + 2;
  char *out = malloc(n);
  if (out != NULL) snprintf(out, n, "%s%s%s", d, *d ? "\\" : "", name);
  free(d);
  return out;
}

int pgs_test_write(pgs_conn *c, const char *dir, char *err, size_t errlen) {
  int rc = pgs_mkdirs(c, dir, err, errlen);
  if (rc != PGS_OK) return rc;
  char *path = join(dir, ".pixelguard-test");
  if (path == NULL) return fail(c, -ENOMEM, err, errlen);
  clear_status(c);
  struct smb2fh *fh = smb2_open(c->smb2, path, O_WRONLY | O_CREAT | O_TRUNC);
  if (fh == NULL) {
    rc = fail(c, -EIO, err, errlen);
    free(path);
    return rc;
  }
  int w = smb2_pwrite(c->smb2, fh, (const uint8_t *)"ok", 2, 0);
  int result = w == 2 ? PGS_OK : fail(c, w, err, errlen);
  if (c->smb2 != NULL) {
    smb2_close(c->smb2, fh);
    smb2_unlink(c->smb2, path);
  }
  free(path);
  return result;
}

// ------------------------------------------------------------------ Envoi

/** Une écriture en vol : son tampon ne doit pas bouger avant la réponse du PC. */
typedef struct {
  uint8_t *buf;
  uint32_t len;
  int done;
  int status;
} wslot;

static void write_cb(struct smb2_context *smb2, int status, void *command_data, void *cb_data) {
  (void)smb2;
  (void)command_data;
  wslot *s = cb_data;
  s->status = status;
  s->done = 1;
}

static void hex(const unsigned char *d, int n, char *out) {
  static const char digits[] = "0123456789abcdef";
  for (int i = 0; i < n; i++) {
    out[2 * i] = digits[d[i] >> 4];
    out[2 * i + 1] = digits[d[i] & 15];
  }
  out[2 * n] = 0;
}

static double mono(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (double)t.tv_sec + (double)t.tv_nsec / 1e9;
}

static int stop_asked(pgs_source *src) { return src != NULL && src->cancelled != NULL && src->cancelled(src->ctx); }

/** Sans réponse du PC pendant ce temps, c'est une coupure. */
#define PGS_REPLY_TIMEOUT 120.0
/** Après Arrêter, le temps laissé au PC pour confirmer les écritures déjà parties. */
#define PGS_STOP_GRACE 2.0

/**
 * Fait tourner libsmb2 jusqu'à ce que `*flag` passe à 1. -ETIMEDOUT si le PC ne répond pas en
 * 120 s. Après Arrêter (ou la fin du temps d'arrière-plan), on laisse encore 2 s au PC, puis
 * -ECANCELED : une réponse peut encore arriver, la connexion devra donc être fermée.
 */
static int service_until(pgs_conn *c, const int *flag, pgs_source *src) {
  double start = mono(), stop_seen = 0;
  while (!*flag) {
    struct smb2_context *smb2 = c->smb2;
    if (smb2 == NULL || !sock_ok(smb2)) return -ENOTCONN;
    struct pollfd pfd;
    memset(&pfd, 0, sizeof(pfd));
    pfd.fd = smb2_get_fd(smb2);
    pfd.events = smb2_which_events(smb2);
    // Par tranches courtes, pour voir Arrêter vite.
    int r = poll(&pfd, 1, 250);
    if (r < 0 && errno != EINTR) return -errno;
    if (smb2->timeout) smb2_timeout_pdus(smb2);
    if (r > 0 && pfd.revents != 0 && smb2_service(smb2, pfd.revents) < 0) {
      if (*flag) break;
      return -ECONNRESET;
    }
    if (*flag) break;
    double t = mono();
    if (stop_asked(src)) {
      if (stop_seen == 0) stop_seen = t;
      else if (t - stop_seen >= PGS_STOP_GRACE) return -ECANCELED;
    }
    if (t - start > PGS_REPLY_TIMEOUT) return -ETIMEDOUT; // « Le PC ne répond plus »
  }
  return 0;
}

static int read_full(pgs_source *src, uint8_t *buf, int max) {
  int filled = 0;
  while (filled < max) {
    int n = src->read(src->ctx, buf + filled, max - filled);
    if (n < 0) return n;
    if (n == 0) break;
    filled += n;
  }
  return filled;
}

/** Codes de lecture de l'original, en plus d'un nombre d'octets. */
#define READ_FAILED (-1)
#define READ_STOPPED (-2)

/**
 * Lit `n` octets de la source et les passe dans le MD5 (le début d'une reprise : il est déjà sur
 * le PC, mais le MD5 rendu doit couvrir tout l'original). Arrêter est regardé à chaque bloc.
 */
static int hash_full(pgs_source *src, uint8_t *scratch, int scratch_len, int64_t n, struct MD5Context *md5) {
  while (n > 0) {
    if (stop_asked(src)) return READ_STOPPED;
    int want = n > scratch_len ? scratch_len : (int)n;
    int got = read_full(src, scratch, want);
    if (got < 0) return stop_asked(src) ? READ_STOPPED : READ_FAILED;
    if (got < want) return READ_FAILED; // fichier plus court que prévu
    MD5Update(md5, scratch, (unsigned)got);
    n -= got;
  }
  return 0;
}

static int pread_full(pgs_conn *c, struct smb2fh *fh, uint8_t *buf, uint32_t len, uint64_t offset, uint32_t max_read) {
  uint32_t got = 0;
  while (got < len) {
    uint32_t want = len - got;
    if (want > max_read) want = max_read;
    int n = smb2_pread(c->smb2, fh, buf + got, want, offset + got);
    if (n <= 0) break;
    got += (uint32_t)n;
  }
  return (int)got;
}

#define RESUME_PROBE (64 * 1024)

/**
 * Un « .part » laissé par un envoi coupé. Les DEPTH dernières écritures étaient peut-être encore
 * en route quand il a été coupé : le PC a pu en appliquer une plus loin sans la précédente, et
 * laisser un trou de zéros. Tout ce qui précède `fin - DEPTH × CHUNK` a en revanche été confirmé.
 * On reprend donc à ce point-là, si les 64 Ko juste avant sont identiques au même endroit de
 * l'original. Renvoie l'octet où reprendre (0 sinon), la source restant positionnée dessus et
 * tout ce qui précède passé dans `md5`. READ_FAILED si l'original ne se lit pas, READ_STOPPED
 * si Arrêter arrive pendant la relecture.
 */
static int64_t resume_offset(pgs_conn *c, struct smb2fh *fh, pgs_source *src, int64_t existing,
                             int64_t expected, uint8_t *scratch, uint32_t max_read, struct MD5Context *md5) {
  if (existing < PGS_RESUME_MIN || expected <= existing) return 0;
  int64_t start = existing - (int64_t)PGS_DEPTH * PGS_CHUNK;
  int probe = start < RESUME_PROBE ? (int)start : RESUME_PROBE;
  if (start <= 0 || probe <= 0) return 0;
  uint8_t *remote = malloc(RESUME_PROBE);
  if (remote == NULL) return 0;
  int64_t result = 0;
  int got = pread_full(c, fh, remote, (uint32_t)probe, (uint64_t)(start - probe), max_read);
  if (got == probe) {
    int rc = hash_full(src, scratch, PGS_CHUNK, start - probe, md5);
    if (rc < 0) {
      result = rc;
    } else {
      int n = read_full(src, scratch, probe);
      if (n < 0) {
        result = stop_asked(src) ? READ_STOPPED : READ_FAILED;
      } else if (n == probe && memcmp(remote, scratch, (size_t)probe) == 0) {
        MD5Update(md5, scratch, (unsigned)probe);
        result = start;
      }
    }
  }
  free(remote);
  return result;
}

int pgs_upload(pgs_conn *c, pgs_source *src, const char *target, int64_t expected, int keep,
               int may_resume, int64_t *sent, char md5_out[33], char *err, size_t errlen) {
  *sent = 0;
  if (md5_out != NULL) md5_out[0] = 0;
  if (!pgs_alive(c)) return fail(c, -ENOTCONN, err, errlen);
  pgs_info info;
  pgs_get_info(c, &info);
  uint32_t chunk = PGS_CHUNK;
  if (info.max_write > 0 && info.max_write < chunk) chunk = info.max_write;
  if (chunk < 4096) chunk = 4096;
  uint32_t max_read = info.max_read > 0 ? info.max_read : 65536;

  char *final_path = norm(target);
  char *part = NULL;
  wslot slots[PGS_DEPTH + 1];
  memset(slots, 0, sizeof(slots));
  int fifo[PGS_DEPTH + 1];
  int head = 0, count = 0;
  int result = PGS_OK;
  int renamed = 0, resumable = 0, opened = 0, part_opened = 0;
  int cancelled = 0, aborted = 0;
  int64_t acked = 0;
  // Ce qui est sûrement sur le PC dans le « .part » (pour décider de le garder à l'arrêt).
  int64_t on_pc = 0;
  struct smb2fh *fh = NULL;
  struct MD5Context md5;
  MD5Init(&md5);

  if (final_path == NULL || (part = malloc(strlen(final_path) + 6)) == NULL) {
    free(final_path);
    seterr(err, errlen, "Mémoire insuffisante");
    return PGS_TRANSFER;
  }
  sprintf(part, "%s.part", final_path);
  for (int i = 0; i <= PGS_DEPTH; i++) {
    slots[i].buf = malloc(PGS_CHUNK);
    if (slots[i].buf == NULL) {
      seterr(err, errlen, "Mémoire insuffisante");
      result = PGS_TRANSFER;
      goto out;
    }
  }

  clear_status(c);
  // Ouvert en exclusif : si un autre téléphone envoie le même nom au même moment, le second est
  // refusé au lieu de mélanger les deux fichiers.
  fh = smb2_open(c->smb2, part,
                 keep ? (O_RDWR | O_CREAT | SMB2_O_EXCLUSIVE_SHARE) : (O_RDWR | O_CREAT | O_TRUNC));
  if (fh == NULL) {
    if (c->smb2 != NULL && (uint32_t)smb2_get_nterror(c->smb2) == SMB2_STATUS_SHARING_VIOLATION) {
      // Juste après une coupure Wi-Fi, Windows garde l'ancien « .part » ouvert un moment : il
      // n'est pas à nous d'y toucher, et il resservira pour la reprise.
      seterr(err, errlen, "Le PC garde ce fichier ouvert (autre appareil, ou envoi coupé à l'instant) : il repartira à la prochaine sauvegarde");
      result = PGS_BUSY;
    } else {
      result = fail(c, -EIO, err, errlen);
    }
    goto out;
  }
  part_opened = 1;
  if (src->open(src->ctx) != 0) {
    seterr(err, errlen, "Impossible de lire l'original");
    result = PGS_TRANSFER;
    goto out;
  }
  opened = 1;

  int64_t existing = 0;
  if (keep) {
    struct smb2_stat_64 st;
    if (smb2_fstat(c->smb2, fh, &st) < 0) {
      result = fail(c, -EIO, err, errlen);
      goto out;
    }
    existing = (int64_t)st.smb2_size;
    on_pc = existing;
  }
  int64_t start = may_resume ? resume_offset(c, fh, src, existing, expected, slots[0].buf, max_read, &md5) : 0;
  if (start == READ_STOPPED) {
    // Arrêté pendant la relecture du début : le « .part » reste pour la prochaine fois.
    seterr(err, errlen, "Arrêté");
    result = PGS_CANCELLED;
    resumable = keep;
    goto out;
  }
  if (start < 0) {
    seterr(err, errlen, "Fichier plus court que prévu");
    result = PGS_TRANSFER;
    goto out;
  }
  // En reprise, tout ce qui suit le point de reprise est réécrit (un éventuel trou disparaît)
  // jusqu'au bout de l'original, plus long que le « .part » : rien à tronquer.
  if (start == 0 && existing > 0) {
    // Rien à reprendre : on repart d'un fichier vide, et d'une source relue du début.
    clear_status(c);
    int rc = smb2_ftruncate(c->smb2, fh, 0);
    if (rc < 0) {
      result = fail(c, rc, err, errlen);
      goto out;
    }
    on_pc = 0;
    src->close(src->ctx);
    opened = 0;
    MD5Init(&md5);
    if (src->open(src->ctx) != 0) {
      seterr(err, errlen, "Impossible de lire l'original");
      result = PGS_TRANSFER;
      goto out;
    }
    opened = 1;
  }

  int64_t issued = start;
  acked = start;
  if (src->progress) src->progress(src->ctx, acked);
  int slot = 0;
  for (;;) {
    if (stop_asked(src)) {
      cancelled = 1;
      break;
    }
    wslot *s = &slots[slot];
    int n = read_full(src, s->buf, (int)chunk);
    if (n < 0) {
      // Une lecture coupée par Arrêter n'est pas une erreur de l'original.
      if (stop_asked(src)) {
        cancelled = 1;
        break;
      }
      seterr(err, errlen, "Lecture de l'original interrompue");
      result = PGS_TRANSFER;
      break;
    }
    if (n == 0) break;
    MD5Update(&md5, s->buf, (unsigned)n);
    // DEPTH+1 tampons : on remplit le suivant pendant que les DEPTH autres sont en vol.
    while (count >= PGS_DEPTH) {
      wslot *h = &slots[fifo[head]];
      int rc = service_until(c, &h->done, src);
      if (rc == -ECANCELED) {
        cancelled = 1;
        aborted = 1;
        goto drain;
      }
      if (rc < 0) {
        result = fail(c, rc, err, errlen);
        goto drain;
      }
      if (h->status < 0) {
        result = fail(c, h->status, err, errlen);
        goto drain;
      }
      if ((uint32_t)h->status != h->len) {
        seterr(err, errlen, "Écriture incomplète sur le PC");
        result = PGS_TRANSFER;
        goto drain;
      }
      acked += h->len;
      head = (head + 1) % (PGS_DEPTH + 1);
      count--;
      if (src->progress) src->progress(src->ctx, acked);
    }
    s->len = (uint32_t)n;
    s->done = 0;
    s->status = 0;
    clear_status(c);
    int rc = smb2_pwrite_async(c->smb2, fh, s->buf, s->len, (uint64_t)issued, write_cb, s);
    if (rc < 0) {
      result = fail(c, rc, err, errlen);
      goto drain;
    }
    fifo[(head + count) % (PGS_DEPTH + 1)] = slot;
    count++;
    issued += n;
    slot = (slot + 1) % (PGS_DEPTH + 1);
  }

drain:
  // Les écritures déjà parties doivent revenir avant qu'on rende les tampons.
  while (count > 0) {
    wslot *h = &slots[fifo[head]];
    if (c->smb2 == NULL || aborted) break;
    int rc = service_until(c, &h->done, src);
    if (rc == -ECANCELED) {
      // Le PC ne confirme pas assez vite après Arrêter : on n'attend plus.
      cancelled = 1;
      aborted = 1;
      break;
    }
    if (rc < 0) {
      if (result == PGS_OK) result = fail(c, rc, err, errlen);
      break;
    }
    if (result == PGS_OK) {
      if (h->status < 0) {
        result = fail(c, h->status, err, errlen);
      } else if ((uint32_t)h->status != h->len) {
        seterr(err, errlen, "Écriture incomplète sur le PC");
        result = PGS_TRANSFER;
      } else {
        acked += h->len;
        if (src->progress) src->progress(src->ctx, acked);
      }
    }
    head = (head + 1) % (PGS_DEPTH + 1);
    count--;
  }
  if (count > 0) {
    // Plus de connexion, ou plus le temps d'attendre : on la ferme avant de libérer les tampons
    // encore référencés.
    kill_conn(c);
    fh = NULL;
  }
  if (acked > on_pc) on_pc = acked;
  if (result == PGS_OK && cancelled) {
    seterr(err, errlen, "Arrêté");
    result = PGS_CANCELLED;
  }
  if (result == PGS_CANCELLED || result == PGS_CONNECTION) {
    // Arrêt ou coupure : ce qui est déjà écrit pourra servir à la reprise.
    resumable = keep;
    if (c->smb2 == NULL) fh = NULL;
    goto out;
  }
  if (result != PGS_OK) goto out;
  if (expected >= 0 && acked != expected) {
    seterr(err, errlen, "Copie incomplète (%lld sur %lld octets)", (long long)acked, (long long)expected);
    result = PGS_TRANSFER;
    goto out;
  }
  if (keep) {
    // Fermé d'abord : le renommage passe par le chemin, sans écraser un fichier existant.
    smb2_close(c->smb2, fh);
    fh = NULL;
    clear_status(c);
    int rc = smb2_rename(c->smb2, part, final_path);
    if (rc < 0) {
      uint32_t st = c->smb2 ? (uint32_t)smb2_get_nterror(c->smb2) : 0;
      if (st == SMB2_STATUS_OBJECT_NAME_COLLISION || rc == -EEXIST) {
        seterr(err, errlen, "Déjà sur le PC sous ce nom");
        result = PGS_EXISTS;
      } else {
        result = fail(c, rc, err, errlen);
      }
      goto out;
    }
    renamed = 1;
  }
  if (md5_out != NULL) {
    unsigned char digest[16];
    MD5Final(digest, &md5);
    hex(digest, 16, md5_out);
  }

out:
  if (opened) src->close(src->ctx);
  if (c->smb2 != NULL && sock_ok(c->smb2)) {
    if (fh != NULL) smb2_close(c->smb2, fh);
    // On garde un « .part » repris plus tard seulement s'il vaut la peine. Un « .part » qu'on n'a
    // pas pu ouvrir (ouvert ailleurs) n'est pas à nous : on n'y touche pas.
    if (part_opened && !renamed && !(resumable && on_pc >= PGS_RESUME_MIN)) smb2_unlink(c->smb2, part);
  }
  for (int i = 0; i <= PGS_DEPTH; i++) free(slots[i].buf);
  free(part);
  free(final_path);
  *sent = acked;
  return result;
}

// ------------------------------------------------------------------ Vérification

int pgs_md5_remote(pgs_conn *c, const char *path, int64_t size, int (*cancelled)(void *), void *ctx,
                   char out[64], char *err, size_t errlen) {
  out[0] = 0;
  if (!pgs_alive(c)) return fail(c, -ENOTCONN, err, errlen);
  char *p = norm(path);
  if (p == NULL) return fail(c, -ENOMEM, err, errlen);
  clear_status(c);
  struct smb2fh *fh = smb2_open(c->smb2, p, O_RDONLY);
  free(p);
  if (fh == NULL) {
    if (not_found((uint32_t)smb2_get_nterror(c->smb2))) return PGS_NOT_FOUND;
    return fail(c, -EIO, err, errlen);
  }
  struct smb2_stat_64 st;
  int result = PGS_OK;
  if (smb2_fstat(c->smb2, fh, &st) < 0) {
    result = fail(c, -EIO, err, errlen);
  } else if ((int64_t)st.smb2_size != size) {
    snprintf(out, 64, "taille:%llu", (unsigned long long)st.smb2_size);
  } else {
    uint32_t max_read = smb2_get_max_read_size(c->smb2);
    uint32_t chunk = PGS_CHUNK;
    if (max_read > 0 && max_read < chunk) chunk = max_read;
    if (chunk < 4096) chunk = 4096;
    uint8_t *buf = malloc(chunk);
    struct MD5Context md5;
    MD5Init(&md5);
    int64_t offset = 0;
    while (buf != NULL && offset < size) {
      if (cancelled && cancelled(ctx)) {
        seterr(err, errlen, "Arrêté");
        result = PGS_CANCELLED;
        break;
      }
      uint32_t want = (uint32_t)((size - offset) < chunk ? (size - offset) : chunk);
      int n = smb2_pread(c->smb2, fh, buf, want, (uint64_t)offset);
      if (n < 0) {
        result = fail(c, n, err, errlen);
        break;
      }
      if (n == 0) {
        snprintf(out, 64, "court:%lld", (long long)offset);
        break;
      }
      MD5Update(&md5, buf, (unsigned)n);
      offset += n;
    }
    if (buf == NULL) {
      seterr(err, errlen, "Mémoire insuffisante");
      result = PGS_TRANSFER;
    } else if (result == PGS_OK && out[0] == 0) {
      unsigned char digest[16];
      MD5Final(digest, &md5);
      hex(digest, 16, out);
    }
    free(buf);
  }
  if (c->smb2 != NULL && sock_ok(c->smb2)) smb2_close(c->smb2, fh);
  return result;
}

// ------------------------------------------------------------------ Fichiers déjà sur le PC

/**
 * Ouvre un fichier du partage en lecture et lit sa taille sur le fichier lui-même. PGS_NOT_FOUND
 * (message « Introuvable sur le PC ») s'il n'existe pas.
 */
static int open_remote(pgs_conn *c, const char *path, struct smb2fh **out, int64_t *size, char *err, size_t errlen) {
  *out = NULL;
  *size = -1;
  if (!pgs_alive(c)) return fail(c, -ENOTCONN, err, errlen);
  char *p = norm(path);
  if (p == NULL) return fail(c, -ENOMEM, err, errlen);
  clear_status(c);
  struct smb2fh *fh = smb2_open(c->smb2, p, O_RDONLY);
  free(p);
  if (fh == NULL) {
    if (c->smb2 != NULL && not_found((uint32_t)smb2_get_nterror(c->smb2))) {
      seterr(err, errlen, "Introuvable sur le PC : %s", path);
      return PGS_NOT_FOUND;
    }
    return fail(c, -EIO, err, errlen);
  }
  struct smb2_stat_64 st;
  if (smb2_fstat(c->smb2, fh, &st) < 0) {
    int rc = fail(c, -EIO, err, errlen);
    if (c->smb2 != NULL && sock_ok(c->smb2)) smb2_close(c->smb2, fh);
    return rc;
  }
  *out = fh;
  *size = (int64_t)st.smb2_size;
  return PGS_OK;
}

static void close_remote(pgs_conn *c, struct smb2fh *fh) {
  if (fh != NULL && c->smb2 != NULL && sock_ok(c->smb2)) smb2_close(c->smb2, fh);
}

/** Taille d'une lecture : 1 Mo, moins si le PC l'impose. */
static uint32_t read_chunk(pgs_conn *c) {
  uint32_t max_read = smb2_get_max_read_size(c->smb2);
  uint32_t chunk = PGS_CHUNK;
  if (max_read > 0 && max_read < chunk) chunk = max_read;
  if (chunk < 4096) chunk = 4096;
  return chunk;
}

int pgs_read_remote(pgs_conn *c, const char *path, int64_t offset, int64_t length, uint8_t *buf, int *got,
                    char *err, size_t errlen) {
  *got = 0;
  if (offset < 0) offset = 0;
  if (length < 0) length = 0;
  if (length > PGS_READ_MAX) length = PGS_READ_MAX;
  struct smb2fh *fh;
  int64_t size;
  int result = open_remote(c, path, &fh, &size, err, errlen);
  if (result != PGS_OK) return result;
  // Fichier plus court : moins d'octets ; au-delà de la fin : rien.
  int64_t want = offset >= size ? 0 : (size - offset < length ? size - offset : length);
  uint32_t chunk = read_chunk(c);
  int64_t done = 0;
  while (done < want) {
    uint32_t n = (uint32_t)(want - done < chunk ? want - done : chunk);
    int r = smb2_pread(c->smb2, fh, buf + done, n, (uint64_t)(offset + done));
    if (r < 0) {
      result = fail(c, r, err, errlen);
      break;
    }
    if (r == 0) break; // raccourci entre-temps
    done += r;
  }
  close_remote(c, fh);
  *got = (int)done;
  return result;
}

int pgs_move(pgs_conn *c, const char *from, const char *to, char *err, size_t errlen) {
  // La source d'abord : un nom introuvable ne doit pas laisser de dossiers vides derrière lui.
  int64_t size;
  int result = pgs_stat(c, from, &size, err, errlen);
  if (result != PGS_OK) return result;
  if (size < 0) {
    seterr(err, errlen, "Introuvable sur le PC : %s", from);
    return PGS_NOT_FOUND;
  }
  char *src = norm(from);
  char *dst = norm(to);
  if (src == NULL || dst == NULL) {
    free(src);
    free(dst);
    return fail(c, -ENOMEM, err, errlen);
  }
  char *slash = strrchr(dst, '\\');
  if (slash != NULL) {
    *slash = 0;
    result = pgs_mkdirs(c, dst, err, errlen);
    *slash = '\\';
  }
  if (result == PGS_OK) {
    clear_status(c);
    // libsmb2 renomme sans remplacer : un nom déjà pris est refusé par le PC, jamais écrasé.
    int rc = smb2_rename(c->smb2, src, dst);
    if (rc < 0) {
      uint32_t st = c->smb2 ? (uint32_t)smb2_get_nterror(c->smb2) : 0;
      if (st == SMB2_STATUS_OBJECT_NAME_COLLISION || rc == -EEXIST) {
        seterr(err, errlen, "Déjà sur le PC sous ce nom");
        result = PGS_EXISTS;
      } else if (not_found(st)) {
        seterr(err, errlen, "Introuvable sur le PC : %s", from);
        result = PGS_NOT_FOUND;
      } else {
        result = fail(c, rc, err, errlen);
      }
    }
  }
  free(src);
  free(dst);
  return result;
}

/** Écrit tout le tampon dans le fichier local (0 si ok). */
static int write_all(int fd, const uint8_t *buf, size_t len) {
  while (len > 0) {
    ssize_t w = write(fd, buf, len);
    if (w < 0) {
      if (errno == EINTR) continue;
      return -1;
    }
    buf += w;
    len -= (size_t)w;
  }
  return 0;
}

int pgs_download(pgs_conn *c, const char *path, const char *local, int64_t expected,
                 void (*progress)(void *, int64_t), int (*cancelled)(void *), void *ctx, int64_t *got,
                 char *err, size_t errlen) {
  *got = 0;
  struct smb2fh *fh;
  int64_t size;
  int result = open_remote(c, path, &fh, &size, err, errlen);
  if (result != PGS_OK) return result;
  if (expected >= 0 && size != expected) {
    // Rien à lire : la copie du PC n'est pas celle attendue.
    close_remote(c, fh);
    seterr(err, errlen, "Copie incomplète (%lld octets sur le PC, %lld attendus)", (long long)size, (long long)expected);
    return PGS_TRANSFER;
  }
  int fd = open(local, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (fd < 0) {
    close_remote(c, fh);
    seterr(err, errlen, "Impossible d'écrire sur le téléphone");
    return PGS_TRANSFER;
  }
  uint32_t chunk = read_chunk(c);
  uint8_t *buf = malloc(chunk);
  int64_t done = 0;
  if (buf == NULL) {
    seterr(err, errlen, "Mémoire insuffisante");
    result = PGS_TRANSFER;
  }
  while (buf != NULL && done < size) {
    if (cancelled && cancelled(ctx)) {
      seterr(err, errlen, "Arrêté");
      result = PGS_CANCELLED;
      break;
    }
    uint32_t want = (uint32_t)(size - done < chunk ? size - done : chunk);
    int n = smb2_pread(c->smb2, fh, buf, want, (uint64_t)done);
    if (n < 0) {
      result = fail(c, n, err, errlen);
      break;
    }
    if (n == 0) break; // raccourci entre-temps : contrôlé plus bas
    if (write_all(fd, buf, (size_t)n) != 0) {
      seterr(err, errlen, "Écriture sur le téléphone impossible (plus de place ?)");
      result = PGS_TRANSFER;
      break;
    }
    done += n;
    if (progress) progress(ctx, done);
  }
  free(buf);
  close_remote(c, fh);
  if (close(fd) != 0 && result == PGS_OK) {
    seterr(err, errlen, "Écriture sur le téléphone impossible (plus de place ?)");
    result = PGS_TRANSFER;
  }
  if (result == PGS_OK && expected >= 0 && done != expected) {
    seterr(err, errlen, "Copie incomplète (%lld sur %lld octets)", (long long)done, (long long)expected);
    result = PGS_TRANSFER;
  }
  // Jamais de fichier à moitié lu laissé sur le téléphone.
  if (result != PGS_OK) unlink(local);
  *got = done;
  return result;
}

// ------------------------------------------------------------------ Nom NetBIOS (UDP 137)

size_t pgs_nbstat_query(uint8_t b[50], uint16_t txid) {
  memset(b, 0, 50);
  b[0] = (uint8_t)(txid >> 8);
  b[1] = (uint8_t)txid;
  b[5] = 1; // une question
  b[12] = 0x20;
  uint8_t name[16] = {'*'};
  for (int i = 0; i < 16; i++) {
    b[13 + 2 * i] = (uint8_t)('A' + ((name[i] >> 4) & 0x0f));
    b[14 + 2 * i] = (uint8_t)('A' + (name[i] & 0x0f));
  }
  b[45] = 0;
  b[46] = 0;
  b[47] = 0x21; // NBSTAT
  b[48] = 0;
  b[49] = 1; // IN
  return 50;
}

int pgs_nbstat_name(const uint8_t *buf, int len, char *out, size_t outlen) {
  int p = 12;
  if (len < p + 1 || outlen < 16) return -1;
  // nom de la question (souvent repris tel quel)
  while (p < len && buf[p] != 0) {
    if ((buf[p] & 0xc0) == 0xc0) {
      p += 1;
      break;
    }
    p += buf[p] + 1;
  }
  p += 1;
  p += 2 + 2 + 4 + 2; // type, classe, TTL, longueur
  if (p >= len) return -1;
  int count = buf[p];
  p += 1;
  for (int i = 0; i < count && p + 18 <= len; i++, p += 18) {
    char name[16];
    memcpy(name, buf + p, 15);
    name[15] = 0;
    int e = 14;
    while (e >= 0 && (name[e] == ' ' || name[e] == 0)) name[e--] = 0;
    int suffix = buf[p + 15];
    int flags = (buf[p + 16] << 8) | buf[p + 17];
    int group = (flags & 0x8000) != 0;
    if (!group && (suffix == 0x00 || suffix == 0x20) && name[0]) {
      snprintf(out, outlen, "%s", name);
      return 0;
    }
  }
  return -1;
}
