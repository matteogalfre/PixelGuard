// Teste PgSmb.c (le cœur SMB de l'iPhone) sur le Mac, contre le serveur SMB local d'impacket.
// Mêmes cas que jvm-test/CoreTest.java, plus trois envois en parallèle sur trois connexions.
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>

#include "../ios/PgSmb.h"
#include "md5.h"
#include "smb2.h"
#include "libsmb2.h"

static const char *SERVER = "127.0.0.1:4445";
static const char *SHARE_DIR;

typedef struct {
  const uint8_t *data;
  int64_t len, pos;
  int64_t first, last;
  int calls;
  int cancel_after_calls;     // 0 : jamais
  int64_t cancel_after_bytes; // 0 : jamais
  int cancel_now;             // Arrêter déjà appuyé
  int opens;
  pid_t freeze_pid;           // serveur à figer (SIGSTOP) après freeze_after octets confirmés
  int64_t freeze_after;
  double frozen_at;           // 0 : pas encore figé
} memsrc;

static int m_open(void *ctx) {
  memsrc *m = ctx;
  m->pos = 0;
  m->opens++;
  return 0;
}
static int m_read(void *ctx, uint8_t *buf, int max) {
  memsrc *m = ctx;
  int64_t n = m->len - m->pos;
  if (n > max) n = max;
  memcpy(buf, m->data + m->pos, (size_t)n);
  m->pos += n;
  return (int)n;
}
static void m_close(void *ctx) { (void)ctx; }
static double now(void);
static void m_progress(void *ctx, int64_t done) {
  memsrc *m = ctx;
  if (m->first < 0) m->first = done;
  m->last = done;
  m->calls++;
  if (m->freeze_pid && m->frozen_at == 0 && done >= m->freeze_after) {
    kill(m->freeze_pid, SIGSTOP); // le PC ne répond plus du tout
    m->frozen_at = now();
  }
}
static int m_cancelled(void *ctx) {
  memsrc *m = ctx;
  if (m->cancel_now) return 1;
  // Arrêter, une demi-seconde après que le PC s'est figé.
  if (m->frozen_at > 0 && now() - m->frozen_at > 0.5) return 1;
  if (m->cancel_after_calls && m->calls > m->cancel_after_calls) return 1;
  if (m->cancel_after_bytes && m->last > m->cancel_after_bytes) return 1;
  return 0;
}

static pgs_source source(memsrc *m, const uint8_t *data, int64_t len) {
  memset(m, 0, sizeof(*m));
  m->data = data;
  m->len = len;
  m->first = -1;
  pgs_source s = {m, m_open, m_read, m_close, m_progress, m_cancelled};
  return s;
}

static uint8_t *random_bytes(int64_t n, unsigned seed) {
  uint8_t *b = malloc((size_t)n);
  srand(seed);
  for (int64_t i = 0; i < n; i++) b[i] = (uint8_t)rand();
  return b;
}

static char *disk_path(const char *rel) {
  static char buf[1024];
  snprintf(buf, sizeof(buf), "%s/%s", SHARE_DIR, rel);
  return buf;
}

static int exists(const char *rel) {
  struct stat st;
  return stat(disk_path(rel), &st) == 0;
}

static long long disk_size(const char *rel) {
  struct stat st;
  return stat(disk_path(rel), &st) == 0 ? (long long)st.st_size : -1;
}

static int same_on_disk(const char *rel, const uint8_t *data, int64_t len) {
  FILE *f = fopen(disk_path(rel), "rb");
  if (!f) return 0;
  uint8_t *b = malloc((size_t)len + 1);
  size_t n = fread(b, 1, (size_t)len + 1, f);
  fclose(f);
  int ok = (int64_t)n == len && memcmp(b, data, (size_t)len) == 0;
  free(b);
  return ok;
}

static void md5hex(const uint8_t *d, int64_t n, char out[33]) {
  struct MD5Context c;
  unsigned char dig[16];
  MD5Init(&c);
  MD5Update(&c, d, (unsigned)n);
  MD5Final(dig, &c);
  for (int i = 0; i < 16; i++) sprintf(out + 2 * i, "%02x", dig[i]);
}

static void print_share(void *ctx, const char *name) {
  (void)ctx;
  printf(" [%s]", name);
}
static void print_entry(void *ctx, const char *name, uint64_t size, int dir) {
  int *n = ctx;
  (*n)++;
  printf("  listé: %s %llu%s\n", name, (unsigned long long)size, dir ? " (dossier)" : "");
}
static void count_entry(void *ctx, const char *name, uint64_t size, int dir) {
  (void)name; (void)size; (void)dir;
  (*(int *)ctx)++;
}

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec + t.tv_nsec / 1e9;
}

typedef struct {
  int id;
  int ok;
} worker;

static void *parallel_worker(void *arg) {
  worker *w = arg;
  char err[256];
  pgs_conn *c;
  if (pgs_connect(SERVER, "PHOTOS", NULL, "test", "test", 1, &c, err, sizeof(err)) != PGS_OK) return NULL;
  int ok = 1;
  for (int i = 0; i < 5; i++) {
    int64_t len = 900000 + w->id * 1000 + i;
    uint8_t *d = random_bytes(len, (unsigned)(w->id * 100 + i));
    char path[128];
    snprintf(path, sizeof(path), "Tel/Parallele/P%d_%d.jpg", w->id, i);
    memsrc m;
    pgs_source s = source(&m, d, len);
    int64_t sent;
    int rc = pgs_upload(c, &s, path, len, 1, 0, &sent, NULL, err, sizeof(err));
    char rel[160];
    snprintf(rel, sizeof(rel), "Tel/Parallele/P%d_%d.jpg", w->id, i);
    if (rc != PGS_OK || !same_on_disk(rel, d, len)) ok = 0;
    free(d);
  }
  pgs_close(c);
  w->ok = ok;
  return NULL;
}

/** MD5 de la même copie, calculé sur une connexion à soi (comme remoteMd5 en parallèle). */
typedef struct {
  const char *want;
  int ok;
} md5_worker;

static void *md5_parallel(void *arg) {
  md5_worker *w = arg;
  char err[256], out[64];
  pgs_conn *c;
  if (pgs_connect(SERVER, "PHOTOS", NULL, "test", "test", 1, &c, err, sizeof(err)) != PGS_OK) return NULL;
  int rc = pgs_md5_remote(c, "Tel/2026 Novembre/IMG_1.jpg", 7340033, NULL, NULL, out, err, sizeof(err));
  w->ok = rc == PGS_OK && strcmp(out, w->want) == 0;
  pgs_close(c);
  return NULL;
}

int main(int argc, char **argv) {
  if (argc < 2) return 2;
  SHARE_DIR = argv[1];
  char err[256] = "";
  pgs_conn *ipc;
  int rc = pgs_connect(SERVER, "IPC$", NULL, "test", "test", 1, &ipc, err, sizeof(err));
  if (rc != PGS_OK) {
    printf("connexion IPC$ ratée (%d) : %s\n", rc, err);
    return 1;
  }
  pgs_info info;
  pgs_get_info(ipc, &info);
  printf("dialect=%s maxWrite=%u signé=%d chiffré=%d\n", pgs_dialect_name(info.dialect), info.max_write, info.sign, info.seal);
  printf("partages=");
  rc = pgs_list_shares(ipc, print_share, NULL, err, sizeof(err));
  printf(rc == PGS_OK ? "\n" : " ÉCHEC (%s)\n", err);
  pgs_close(ipc);

  pgs_conn *bad;
  rc = pgs_connect(SERVER, "PHOTOS", NULL, "test", "faux", 1, &bad, err, sizeof(err));
  printf("mauvais mot de passe : code=%d (%s)\n", rc, rc == PGS_AUTH ? "AUTH, ok" : err);
  rc = pgs_connect(SERVER, "NOPE", NULL, "test", "test", 1, &bad, err, sizeof(err));
  printf("partage absent : code=%d (%s)\n", rc, rc == PGS_SHARE ? "SHARE, ok" : err);
  rc = pgs_connect("127.0.0.1:4499", "PHOTOS", NULL, "test", "test", 1, &bad, err, sizeof(err));
  printf("port fermé : code=%d (%s)\n", rc, rc == PGS_UNREACHABLE ? "UNREACHABLE, ok" : err);

  // Le PC ferme une connexion restée inactive (ici : on arrête le second serveur). Elle doit être
  // vue comme morte avant usage, et un appel doit répondre « connexion perdue ».
  if (argc > 2) {
    pgs_conn *idle;
    rc = pgs_connect("127.0.0.1:4446", "PHOTOS", NULL, "test", "test", 1, &idle, err, sizeof(err));
    int before = rc == PGS_OK ? pgs_alive(idle) : -1;
    kill((pid_t)atoi(argv[2]), SIGTERM);
    usleep(800 * 1000);
    int after = rc == PGS_OK ? pgs_alive(idle) : -1;
    int64_t sz = 0;
    int op = rc == PGS_OK ? pgs_stat(idle, "Tel", &sz, err, sizeof(err)) : -1;
    printf("connexion fermée par le PC : vivante avant=%d, après=%d, appel=%s\n", before, after,
           op == PGS_CONNECTION ? "CONNECTION, ok" : "AUTRE");
    if (rc == PGS_OK) pgs_close(idle);
  }

  // Chiffrement exigé face à un PC en SMB 2 : refus, pas de repli silencieux.
  {
    pgs_conn *x = NULL;
    rc = pgs_connect2(SERVER, "PHOTOS", NULL, "test", "test", PGS_SEAL_MUST, NULL, NULL, 0, &x, err, sizeof(err));
    printf("chiffrement exigé sur un PC en SMB 2 : %s\n", rc == PGS_NOT_ENCRYPTED ? "refusé (NOT_ENCRYPTED), ok" : "ACCEPTÉ");
    if (x) pgs_close(x);
    // Nom du PC lu dans le défi NTLM, avant de répondre : bon nom, puis un autre.
    char seen[64] = "";
    rc = pgs_connect2(SERVER, "PHOTOS", NULL, "test", "test", PGS_SEAL_IF_POSSIBLE, NULL, seen, sizeof(seen), &x, err, sizeof(err));
    if (x) pgs_close(x);
    x = NULL;
    char again[64] = "";
    int good = pgs_connect2(SERVER, "PHOTOS", NULL, "test", "test", PGS_SEAL_IF_POSSIBLE, seen, again, sizeof(again), &x, err, sizeof(err));
    if (x) pgs_close(x);
    x = NULL;
    int bad = pgs_connect2(SERVER, "PHOTOS", NULL, "test", "test", PGS_SEAL_IF_POSSIBLE, "AUTRE-PC", NULL, 0, &x, err, sizeof(err));
    if (x) pgs_close(x);
    printf("nom annoncé=%s, même nom : %s, autre nom : %s\n", seen, good == PGS_OK ? "accepté" : "REFUSÉ",
           bad == PGS_PC_CHANGED ? "refusé avant la réponse NTLM (PC_CHANGED)" : "ACCEPTÉ");
  }

  pgs_conn *c;
  rc = pgs_connect(SERVER, "PHOTOS", NULL, "test", "test", 1, &c, err, sizeof(err));
  if (rc != PGS_OK) {
    printf("connexion PHOTOS ratée : %s\n", err);
    return 1;
  }
  int n = 0;
  pgs_list(c, "Tel/2026 Novembre", count_entry, &n, err, sizeof(err));
  printf("liste dossier absent=%d\n", n);
  pgs_mkdirs(c, "Tel/2026 Novembre", err, sizeof(err));
  rc = pgs_mkdirs(c, "Tel/2026 Novembre", err, sizeof(err));
  printf("mkdirs deux fois=%s\n", rc == PGS_OK ? "ok" : err);
  rc = pgs_test_write(c, "Tel", err, sizeof(err));
  printf("test d'écriture=%s, fichier restant=%d\n", rc == PGS_OK ? "ok" : err, exists("Tel/.pixelguard-test"));

  int64_t len = 7340033;
  uint8_t *data = random_bytes(len, 7);
  memsrc m;
  pgs_source s = source(&m, data, len);
  int64_t sent;
  char up_md5[33] = "", want_md5[33];
  double t = now();
  rc = pgs_upload(c, &s, "Tel/2026 Novembre/IMG_1.jpg", len, 1, 0, &sent, up_md5, err, sizeof(err));
  double sec = now() - t;
  md5hex(data, len, want_md5);
  printf("md5 rendu par l'envoi = md5 du fichier : %s\n", strcmp(up_md5, want_md5) == 0 ? "ok" : "DIFFÉRENT");
  printf("envoi=%lld octets (rc=%d %s), progression=%d appels (dernier %lld), %.1f Mo/s\n", (long long)sent, rc,
         rc ? err : "", m.calls, (long long)m.last, sent / sec / 1e6);
  printf("identique sur disque=%d, .part restant=%d\n", same_on_disk("Tel/2026 Novembre/IMG_1.jpg", data, len),
         exists("Tel/2026 Novembre/IMG_1.jpg.part"));
  n = 0;
  pgs_list(c, "Tel/2026 Novembre", print_entry, &n, err, sizeof(err));

  char local[33], remote[64];
  md5hex(data, len, local);
  // Taille lue sur le fichier : présent, absent, dossier absent.
  int64_t st1 = 0, st2 = 0, st3 = 0;
  int r1 = pgs_stat(c, "Tel/2026 Novembre/IMG_1.jpg", &st1, err, sizeof(err));
  int r2 = pgs_stat(c, "Tel/2026 Novembre/absent.jpg", &st2, err, sizeof(err));
  int r3 = pgs_stat(c, "Tel/Pas de dossier/IMG_1.jpg", &st3, err, sizeof(err));
  printf("stat présent=%lld (attendu %lld) absent=%lld dossier absent=%lld, codes %d %d %d, connexion %s\n",
         (long long)st1, (long long)len, (long long)st2, (long long)st3, r1, r2, r3, pgs_alive(c) ? "ok" : "PERDUE");
  rc = pgs_md5_remote(c, "Tel/2026 Novembre/IMG_1.jpg", len, NULL, NULL, remote, err, sizeof(err));
  printf("md5 local=remote %d", rc == PGS_OK && strcmp(local, remote) == 0);
  rc = pgs_md5_remote(c, "Tel/nope.jpg", 5, NULL, NULL, remote, err, sizeof(err));
  printf(" absent=%s", rc == PGS_NOT_FOUND ? "NOT_FOUND" : "??");
  rc = pgs_md5_remote(c, "Tel/2026 Novembre/IMG_1.jpg", len + 1, NULL, NULL, remote, err, sizeof(err));
  printf(" mauvaise taille=%s\n", remote);

  s = source(&m, data, len);
  rc = pgs_upload(c, &s, "Tel/2026 Novembre/IMG_1.jpg", len, 1, 0, &sent, NULL, err, sizeof(err));
  printf("collision %s: %s\n", rc == PGS_EXISTS ? "détectée" : "NON détectée", err);
  printf("après collision, .part restant=%d\n", exists("Tel/2026 Novembre/IMG_1.jpg.part"));

  s = source(&m, data, len);
  m.cancel_after_calls = 3;
  rc = pgs_upload(c, &s, "Tel/2026 Novembre/IMG_2.jpg", len, 1, 0, &sent, NULL, err, sizeof(err));
  printf("arrêt %s, fichier=%d part=%d\n", rc == PGS_CANCELLED ? "ok" : "NON pris en compte",
         exists("Tel/2026 Novembre/IMG_2.jpg"), exists("Tel/2026 Novembre/IMG_2.jpg.part"));

  int64_t sz = 64LL << 20;
  uint8_t *noise = random_bytes(sz, 1);
  s = source(&m, noise, sz);
  t = now();
  rc = pgs_upload(c, &s, "Tel/.pixelguard-vitesse", sz, 0, 0, &sent, NULL, err, sizeof(err));
  sec = now() - t;
  printf("test de vitesse 64 Mo: %.1f Mo/s (rc=%d), fichier restant=%d\n", sz / sec / 1e6, rc,
         exists("Tel/.pixelguard-vitesse.part") || exists("Tel/.pixelguard-vitesse"));
  free(noise);

  // Reprise : un envoi de 20 Mo coupé vers 12 Mo garde son .part, le suivant repart de là.
  int64_t blen = 20LL << 20;
  uint8_t *big = random_bytes(blen, 3);
  const char *big_path = "Tel/2026 Novembre/VID_1.mp4";
  s = source(&m, big, blen);
  m.cancel_after_bytes = 12LL << 20;
  rc = pgs_upload(c, &s, big_path, blen, 1, 1, &sent, NULL, err, sizeof(err));
  printf("coupé (rc=%d), .part gardé=%d (%lld Mo)\n", rc, exists("Tel/2026 Novembre/VID_1.mp4.part"),
         disk_size("Tel/2026 Novembre/VID_1.mp4.part") / 1048576);
  s = source(&m, big, blen);
  rc = pgs_upload(c, &s, big_path, blen, 1, 1, &sent, up_md5, err, sizeof(err));
  md5hex(big, blen, want_md5);
  printf("repris à %lld Mo (rc=%d), identique=%d, .part restant=%d, md5 rendu=md5 du fichier : %s\n",
         (long long)(m.first / 1048576), rc, same_on_disk(big_path, big, blen),
         exists("Tel/2026 Novembre/VID_1.mp4.part"), strcmp(up_md5, want_md5) == 0 ? "ok" : "DIFFÉRENT");

  // Un .part écrit par un autre original : on repart de zéro, même si ses 64 derniers Ko ressemblent.
  uint8_t *other = malloc((size_t)blen);
  memcpy(other, big, (size_t)blen);
  other[(12 << 20) - 10] ^= 1;
  const char *other_path = "Tel/2026 Novembre/VID_2.mp4";
  s = source(&m, other, blen);
  m.cancel_after_bytes = 12LL << 20;
  pgs_upload(c, &s, other_path, blen, 1, 1, &sent, NULL, err, sizeof(err));
  s = source(&m, big, blen);
  rc = pgs_upload(c, &s, other_path, blen, 1, 0, &sent, NULL, err, sizeof(err));
  printf(".part différent : reparti de %lld (rc=%d), identique=%d\n", (long long)m.first, rc,
         same_on_disk(other_path, big, blen));
  // Même original mais octets différents avant les 64 derniers Ko : reprise refusée au contrôle.
  s = source(&m, other, blen);
  m.cancel_after_bytes = 12LL << 20;
  pgs_upload(c, &s, "Tel/2026 Novembre/VID_3.mp4", blen, 1, 1, &sent, NULL, err, sizeof(err));
  uint8_t *third = malloc((size_t)blen);
  memcpy(third, other, (size_t)blen);
  long long cut = disk_size("Tel/2026 Novembre/VID_3.mp4.part");
  // juste avant le point de reprise (fin - DEPTH × CHUNK), dans les 64 Ko contrôlés
  third[cut - (long long)PGS_DEPTH * PGS_CHUNK - 1000] ^= 1;
  s = source(&m, third, blen);
  rc = pgs_upload(c, &s, "Tel/2026 Novembre/VID_3.mp4", blen, 1, 1, &sent, up_md5, err, sizeof(err));
  md5hex(third, blen, want_md5);
  printf("avant le point de reprise différent : reparti de %lld (rc=%d), identique=%d, md5 : %s\n", (long long)m.first, rc,
         same_on_disk("Tel/2026 Novembre/VID_3.mp4", third, blen), strcmp(up_md5, want_md5) == 0 ? "ok" : "DIFFÉRENT");

  // Un .part avec un trou avant la fin (écritures en vol perdues à la coupure) : on reprend
  // 4 Mo plus tôt, donc le trou est réécrit.
  {
    const char *hole_path = "Tel/2026 Novembre/VID_5.mp4";
    char *hp = disk_path("Tel/2026 Novembre/VID_5.mp4.part");
    FILE *hf = fopen(hp, "wb");
    uint8_t *holed = malloc(12 << 20);
    memcpy(holed, big, 12 << 20);
    memset(holed + (10 << 20), 0, 1 << 20);
    fwrite(holed, 1, 12 << 20, hf);
    fclose(hf);
    free(holed);
    s = source(&m, big, blen);
    rc = pgs_upload(c, &s, hole_path, blen, 1, 1, &sent, up_md5, err, sizeof(err));
    md5hex(big, blen, want_md5);
    printf("trou avant la fin : repris à %lld Mo (rc=%d), identique=%d, md5 : %s\n", (long long)(m.first / 1048576), rc,
           same_on_disk(hole_path, big, blen), strcmp(up_md5, want_md5) == 0 ? "ok" : "DIFFÉRENT");
  }

  // Arrêter pendant la relecture du début d'une reprise : on s'arrête tout de suite, et le .part
  // reste pour la fois suivante.
  {
    const char *stop_path = "Tel/2026 Novembre/VID_6.mp4";
    s = source(&m, big, blen);
    m.cancel_after_bytes = 12LL << 20;
    pgs_upload(c, &s, stop_path, blen, 1, 1, &sent, NULL, err, sizeof(err));
    long long kept = disk_size("Tel/2026 Novembre/VID_6.mp4.part");
    s = source(&m, big, blen);
    m.cancel_now = 1;
    rc = pgs_upload(c, &s, stop_path, blen, 1, 1, &sent, NULL, err, sizeof(err));
    printf("arrêt pendant la relecture d'une reprise : rc=%s, lu=%lld octets, .part gardé=%d (%lld Mo)\n",
           rc == PGS_CANCELLED ? "CANCELLED, ok" : "AUTRE", (long long)m.pos,
           disk_size("Tel/2026 Novembre/VID_6.mp4.part") == kept, kept / 1048576);
  }

  // Un .part encore ouvert par une autre session (autre téléphone, ou envoi coupé que Windows
  // n'a pas encore lâché) : BUSY, et le .part n'est pas touché.
  {
    struct smb2_context *other_smb = smb2_init_context();
    smb2_set_user(other_smb, "test");
    smb2_set_password(other_smb, "test");
    smb2_set_security_mode(other_smb, SMB2_NEGOTIATE_SIGNING_ENABLED);
    smb2_set_sign(other_smb, 1);
    struct smb2fh *held = NULL;
    if (smb2_connect_share(other_smb, SERVER, "PHOTOS", NULL) == 0) {
      held = smb2_open(other_smb, "Tel\\2026 Novembre\\IMG_9.jpg.part", O_RDWR | O_CREAT);
      if (held) smb2_pwrite(other_smb, held, data, 1000, 0);
    }
    s = source(&m, data, len);
    rc = pgs_upload(c, &s, "Tel/2026 Novembre/IMG_9.jpg", len, 1, 1, &sent, NULL, err, sizeof(err));
    if (held == NULL) {
      printf(".part ouvert ailleurs : pas pu l'ouvrir depuis une autre session (non vérifié)\n");
    } else if (rc == PGS_BUSY) {
      printf(".part ouvert ailleurs : BUSY, ok, .part intact=%d\n", disk_size("Tel/2026 Novembre/IMG_9.jpg.part") == 1000);
    } else {
      printf(".part ouvert ailleurs : rc=%d, le serveur de test n'applique pas les verrous de partage (BUSY non vérifiable ici)\n", rc);
    }
    if (held) smb2_close(other_smb, held);
    smb2_disconnect_share(other_smb);
    smb2_destroy_context(other_smb);
  }

  // Un petit fichier coupé ne laisse pas de .part (moins de 8 Mo : on recommence).
  s = source(&m, data, len);
  m.cancel_after_calls = 3;
  rc = pgs_upload(c, &s, "Tel/2026 Novembre/IMG_3.jpg", len, 1, 1, &sent, NULL, err, sizeof(err));
  printf("petit fichier coupé (rc=%d), .part restant=%d\n", rc, exists("Tel/2026 Novembre/IMG_3.jpg.part"));

  // Taille annoncée fausse : refus, pas de faux fichier fini.
  s = source(&m, data, len);
  rc = pgs_upload(c, &s, "Tel/2026 Novembre/IMG_4.jpg", len + 5, 1, 0, &sent, NULL, err, sizeof(err));
  printf("taille fausse : rc=%d (%s), fichier=%d part=%d\n", rc, err, exists("Tel/2026 Novembre/IMG_4.jpg"),
         exists("Tel/2026 Novembre/IMG_4.jpg.part"));

  // Noms avec accents et espaces.
  s = source(&m, data, 1000);
  rc = pgs_upload(c, &s, "Tel/2026 Février/Été à la mer (1).jpg", 1000, 1, 0, &sent, NULL, err, sizeof(err));
  if (rc == PGS_UNREACHABLE) printf("?");
  pgs_mkdirs(c, "Tel/2026 Février", err, sizeof(err));
  s = source(&m, data, 1000);
  rc = pgs_upload(c, &s, "Tel/2026 Février/Été à la mer (1).jpg", 1000, 1, 0, &sent, NULL, err, sizeof(err));
  printf("accents : rc=%d identique=%d\n", rc, same_on_disk("Tel/2026 Février/Été à la mer (1).jpg", data, 1000));

  // Lecture partielle (EXIF) : début, milieu (plafonné à 1 Mo), fin, au-delà, absent.
  {
    const char *img = "Tel/2026 Novembre/IMG_1.jpg";
    uint8_t *rb = malloc(PGS_READ_MAX);
    int g1 = -1, g2 = -1, g3 = -1, g4 = -1, g5 = -1;
    int a = pgs_read_remote(c, img, 0, 100, rb, &g1, err, sizeof(err));
    int ok1 = a == PGS_OK && g1 == 100 && memcmp(rb, data, 100) == 0;
    int b = pgs_read_remote(c, img, 3000000, 2 << 20, rb, &g2, err, sizeof(err));
    int ok2 = b == PGS_OK && g2 == PGS_READ_MAX && memcmp(rb, data + 3000000, PGS_READ_MAX) == 0;
    int d = pgs_read_remote(c, img, len - 10, 100, rb, &g3, err, sizeof(err));
    int ok3 = d == PGS_OK && g3 == 10 && memcmp(rb, data + len - 10, 10) == 0;
    int e = pgs_read_remote(c, img, len + 5, 100, rb, &g4, err, sizeof(err));
    int f = pgs_read_remote(c, "Tel/nope.jpg", 0, 100, rb, &g5, err, sizeof(err));
    printf("lecture partielle : début=%s milieu=%s (%d octets) fin=%s (%d octets) au-delà=%d octets (rc=%d) absent=%s\n",
           ok1 ? "ok" : "FAUX", ok2 ? "ok" : "FAUX", g2, ok3 ? "ok" : "FAUX", g3, g4, e,
           f == PGS_NOT_FOUND ? "NOT_FOUND" : "??");
    free(rb);
  }

  // MD5 de la copie du PC : bon, absent, autre taille, Arrêter.
  {
    char md[64];
    int a = pgs_md5_remote(c, "Tel/2026 Novembre/IMG_1.jpg", len, NULL, NULL, md, err, sizeof(err));
    int ok = a == PGS_OK && strcmp(md, local) == 0;
    int b = pgs_md5_remote(c, "Tel/Absent/IMG_1.jpg", len, NULL, NULL, md, err, sizeof(err));
    char sz[64];
    pgs_md5_remote(c, "Tel/2026 Novembre/IMG_1.jpg", 1234, NULL, NULL, sz, err, sizeof(err));
    memsrc stop;
    memset(&stop, 0, sizeof(stop));
    stop.cancel_now = 1;
    int d = pgs_md5_remote(c, "Tel/2026 Novembre/IMG_1.jpg", len, m_cancelled, &stop, md, err, sizeof(err));
    printf("remoteMd5 : bon=%s absent=%s autre taille=%s arrêt=%s\n", ok ? "ok" : "FAUX",
           b == PGS_NOT_FOUND ? "NOT_FOUND" : "??", sz, d == PGS_CANCELLED ? "CANCELLED, ok" : "AUTRE");
  }

  // Ranger : dossiers créés, jamais d'écrasement, source absente.
  {
    pgs_mkdirs(c, "Tel/Ranger", err, sizeof(err));
    s = source(&m, data, 1000);
    pgs_upload(c, &s, "Tel/Ranger/A.jpg", 1000, 1, 0, &sent, NULL, err, sizeof(err));
    int a = pgs_move(c, "Tel/Ranger/A.jpg", "Tel/Ranger/2026/Novembre/A.jpg", err, sizeof(err));
    int moved = a == PGS_OK && same_on_disk("Tel/Ranger/2026/Novembre/A.jpg", data, 1000) && !exists("Tel/Ranger/A.jpg");
    s = source(&m, data + 1, 1000);
    pgs_upload(c, &s, "Tel/Ranger/A.jpg", 1000, 1, 0, &sent, NULL, err, sizeof(err));
    int b = pgs_move(c, "Tel/Ranger/A.jpg", "Tel/Ranger/2026/Novembre/A.jpg", err, sizeof(err));
    int intact = same_on_disk("Tel/Ranger/2026/Novembre/A.jpg", data, 1000) && same_on_disk("Tel/Ranger/A.jpg", data + 1, 1000);
    char nf[256] = "";
    int d = pgs_move(c, "Tel/Ranger/Absent.jpg", "Tel/Ranger/Jamais/Absent.jpg", nf, sizeof(nf));
    printf("move : déplacé avec dossiers créés=%s, cible existante=%s (les deux intacts=%d), source absente=%s (%s), dossier créé quand même=%d\n",
           moved ? "ok" : "FAUX", b == PGS_EXISTS ? "EXISTS" : "ÉCRASÉE ?", intact,
           d == PGS_NOT_FOUND ? "NOT_FOUND" : "??", nf, exists("Tel/Ranger/Jamais"));
  }

  // Ramener sur le téléphone : copie complète, taille fausse, Arrêter, absent.
  {
    char lp[1024];
    snprintf(lp, sizeof(lp), "%s/../out/ramene.jpg", SHARE_DIR);
    const char *img = "Tel/2026 Novembre/IMG_1.jpg";
    memsrc pr;
    memset(&pr, 0, sizeof(pr));
    pr.first = -1;
    int64_t got = 0;
    int a = pgs_download(c, img, lp, len, m_progress, m_cancelled, &pr, &got, err, sizeof(err));
    struct stat lst;
    int same = 0;
    FILE *lf = fopen(lp, "rb");
    if (lf) {
      uint8_t *lb = malloc((size_t)len + 1);
      size_t ln = fread(lb, 1, (size_t)len + 1, lf);
      fclose(lf);
      same = (int64_t)ln == len && memcmp(lb, data, (size_t)len) == 0;
      free(lb);
    }
    printf("download : rc=%d, %lld octets, identique=%d, progression=%d appels (dernier %lld)\n", a, (long long)got, same,
           pr.calls, (long long)pr.last);
    unlink(lp);
    int b = pgs_download(c, img, lp, len + 1, m_progress, m_cancelled, &pr, &got, err, sizeof(err));
    printf("download taille fausse : %s (%s), fichier local=%d\n", b == PGS_TRANSFER ? "TRANSFER" : "??", err, stat(lp, &lst) == 0);
    memset(&pr, 0, sizeof(pr));
    pr.cancel_after_calls = 2;
    int d = pgs_download(c, img, lp, len, m_progress, m_cancelled, &pr, &got, err, sizeof(err));
    printf("download arrêté : %s après %lld octets, fichier local=%d\n", d == PGS_CANCELLED ? "CANCELLED, ok" : "AUTRE",
           (long long)got, stat(lp, &lst) == 0);
    int e = pgs_download(c, "Tel/nope.jpg", lp, 5, NULL, NULL, NULL, &got, err, sizeof(err));
    printf("download absent : %s (%s), connexion %s\n", e == PGS_NOT_FOUND ? "NOT_FOUND" : "??", err, pgs_alive(c) ? "ok" : "PERDUE");
  }
  pgs_close(c);

  // Trois connexions, trois envois à la fois (comme l'appli).
  pgs_conn *setup;
  pgs_connect(SERVER, "PHOTOS", NULL, "test", "test", 1, &setup, err, sizeof(err));
  pgs_mkdirs(setup, "Tel/Parallele", err, sizeof(err));
  pgs_close(setup);
  pthread_t th[3];
  worker w[3];
  for (int i = 0; i < 3; i++) {
    w[i].id = i;
    w[i].ok = 0;
    pthread_create(&th[i], NULL, parallel_worker, &w[i]);
  }
  for (int i = 0; i < 3; i++) pthread_join(th[i], NULL);
  printf("trois envois en parallèle : %s\n", w[0].ok && w[1].ok && w[2].ok ? "ok" : "ÉCHEC");
  md5_worker mw[3];
  for (int i = 0; i < 3; i++) {
    mw[i].want = local;
    mw[i].ok = 0;
    pthread_create(&th[i], NULL, md5_parallel, &mw[i]);
  }
  for (int i = 0; i < 3; i++) pthread_join(th[i], NULL);
  printf("trois remoteMd5 en parallèle : %s\n", mw[0].ok && mw[1].ok && mw[2].ok ? "ok" : "ÉCHEC");

  // Le PC ne répond plus du tout (serveur figé) en plein envoi, puis Arrêter : on n'attend pas
  // les 60 s de libsmb2 ni les 120 s du délai, on rend la main en 2 à 3 s.
  if (argc > 3) {
    pid_t frozen = (pid_t)atoi(argv[3]);
    pgs_conn *fc = NULL;
    rc = pgs_connect("127.0.0.1:4447", "PHOTOS", NULL, "test", "test", 1, &fc, err, sizeof(err));
    if (rc == PGS_OK) {
      pgs_mkdirs(fc, "Tel/Fige", err, sizeof(err));
      int64_t flen = 48LL << 20;
      uint8_t *fd = random_bytes(flen, 11);
      s = source(&m, fd, flen);
      m.freeze_pid = frozen;
      m.freeze_after = 2LL << 20;
      double t0 = now();
      rc = pgs_upload(fc, &s, "Tel/Fige/VID_F.mp4", flen, 1, 1, &sent, NULL, err, sizeof(err));
      double waited = m.frozen_at > 0 ? now() - m.frozen_at : now() - t0;
      kill(frozen, SIGCONT);
      printf("PC figé puis Arrêter : rc=%s, rendu %.1f s après le gel\n", rc == PGS_CANCELLED ? "CANCELLED, ok" : "AUTRE", waited);
      pgs_close(fc);
      free(fd);
    } else {
      printf("PC figé : connexion ratée (%s)\n", err);
    }
  }

  // Nom NetBIOS : réponse type d'un PC Windows (même vecteur que NbParse.java).
  uint8_t r[200];
  int p = 0;
  uint8_t q[50];
  pgs_nbstat_query(q, 1);
  uint8_t hdr[] = {0x12, 0x34, 0x84, 0x00, 0, 0, 0, 1, 0, 0, 0, 0};
  memcpy(r, hdr, 12);
  p = 12;
  memcpy(r + p, q + 12, 34);
  p += 34;
  uint8_t tail[] = {0, 0x21, 0, 1, 0, 0, 0, 0, 0, 1 + 3 * 18 + 46, 3};
  memcpy(r + p, tail, sizeof(tail));
  p += sizeof(tail);
  const char *names[] = {"WORKGROUP", "DESKTOP-AB12CD", "DESKTOP-AB12CD"};
  int suffix[] = {0, 0, 0x20};
  int flags[] = {0x8400, 0x0400, 0x0400};
  for (int i = 0; i < 3; i++) {
    memset(r + p, ' ', 15);
    memcpy(r + p, names[i], strlen(names[i]));
    r[p + 15] = (uint8_t)suffix[i];
    r[p + 16] = (uint8_t)(flags[i] >> 8);
    r[p + 17] = (uint8_t)flags[i];
    p += 18;
  }
  memset(r + p, 0, 46);
  p += 46;
  char name[32] = "";
  pgs_nbstat_name(r, p, name, sizeof(name));
  char coded[33];
  memcpy(coded, q + 13, 32);
  coded[32] = 0;
  printf("nom NetBIOS lu=%s, requête codée=%s\n", name, coded);
  free(data);
  free(big);
  free(other);
  free(third);
  return 0;
}
