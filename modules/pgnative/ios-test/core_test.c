// Teste PgSmb.c (le cœur SMB de l'iPhone) sur le Mac, contre le serveur SMB local d'impacket.
// Mêmes cas que jvm-test/CoreTest.java, plus trois envois en parallèle sur trois connexions.
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>

#include "../ios/PgSmb.h"
#include "md5.h"

static const char *SERVER = "127.0.0.1:4445";
static const char *SHARE_DIR;

typedef struct {
  const uint8_t *data;
  int64_t len, pos;
  int64_t first, last;
  int calls;
  int cancel_after_calls;     // 0 : jamais
  int64_t cancel_after_bytes; // 0 : jamais
  int opens;
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
static void m_progress(void *ctx, int64_t done) {
  memsrc *m = ctx;
  if (m->first < 0) m->first = done;
  m->last = done;
  m->calls++;
}
static int m_cancelled(void *ctx) {
  memsrc *m = ctx;
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
    int rc = pgs_upload(c, &s, path, len, 1, 0, &sent, err, sizeof(err));
    char rel[160];
    snprintf(rel, sizeof(rel), "Tel/Parallele/P%d_%d.jpg", w->id, i);
    if (rc != PGS_OK || !same_on_disk(rel, d, len)) ok = 0;
    free(d);
  }
  pgs_close(c);
  w->ok = ok;
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
  double t = now();
  rc = pgs_upload(c, &s, "Tel/2026 Novembre/IMG_1.jpg", len, 1, 0, &sent, err, sizeof(err));
  double sec = now() - t;
  printf("envoi=%lld octets (rc=%d %s), progression=%d appels (dernier %lld), %.1f Mo/s\n", (long long)sent, rc,
         rc ? err : "", m.calls, (long long)m.last, sent / sec / 1e6);
  printf("identique sur disque=%d, .part restant=%d\n", same_on_disk("Tel/2026 Novembre/IMG_1.jpg", data, len),
         exists("Tel/2026 Novembre/IMG_1.jpg.part"));
  n = 0;
  pgs_list(c, "Tel/2026 Novembre", print_entry, &n, err, sizeof(err));

  char local[33], remote[64];
  md5hex(data, len, local);
  rc = pgs_md5_remote(c, "Tel/2026 Novembre/IMG_1.jpg", len, NULL, NULL, remote, err, sizeof(err));
  printf("md5 local=remote %d", rc == PGS_OK && strcmp(local, remote) == 0);
  rc = pgs_md5_remote(c, "Tel/nope.jpg", 5, NULL, NULL, remote, err, sizeof(err));
  printf(" absent=%s", rc == PGS_NOT_FOUND ? "NOT_FOUND" : "??");
  rc = pgs_md5_remote(c, "Tel/2026 Novembre/IMG_1.jpg", len + 1, NULL, NULL, remote, err, sizeof(err));
  printf(" mauvaise taille=%s\n", remote);

  s = source(&m, data, len);
  rc = pgs_upload(c, &s, "Tel/2026 Novembre/IMG_1.jpg", len, 1, 0, &sent, err, sizeof(err));
  printf("collision %s: %s\n", rc == PGS_EXISTS ? "détectée" : "NON détectée", err);
  printf("après collision, .part restant=%d\n", exists("Tel/2026 Novembre/IMG_1.jpg.part"));

  s = source(&m, data, len);
  m.cancel_after_calls = 3;
  rc = pgs_upload(c, &s, "Tel/2026 Novembre/IMG_2.jpg", len, 1, 0, &sent, err, sizeof(err));
  printf("arrêt %s, fichier=%d part=%d\n", rc == PGS_CANCELLED ? "ok" : "NON pris en compte",
         exists("Tel/2026 Novembre/IMG_2.jpg"), exists("Tel/2026 Novembre/IMG_2.jpg.part"));

  int64_t sz = 64LL << 20;
  uint8_t *noise = random_bytes(sz, 1);
  s = source(&m, noise, sz);
  t = now();
  rc = pgs_upload(c, &s, "Tel/.pixelguard-vitesse", sz, 0, 0, &sent, err, sizeof(err));
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
  rc = pgs_upload(c, &s, big_path, blen, 1, 1, &sent, err, sizeof(err));
  printf("coupé (rc=%d), .part gardé=%d (%lld Mo)\n", rc, exists("Tel/2026 Novembre/VID_1.mp4.part"),
         disk_size("Tel/2026 Novembre/VID_1.mp4.part") / 1048576);
  s = source(&m, big, blen);
  rc = pgs_upload(c, &s, big_path, blen, 1, 1, &sent, err, sizeof(err));
  printf("repris à %lld Mo (rc=%d), identique=%d, .part restant=%d\n", (long long)(m.first / 1048576), rc,
         same_on_disk(big_path, big, blen), exists("Tel/2026 Novembre/VID_1.mp4.part"));

  // Un .part écrit par un autre original : on repart de zéro, même si ses 64 derniers Ko ressemblent.
  uint8_t *other = malloc((size_t)blen);
  memcpy(other, big, (size_t)blen);
  other[(12 << 20) - 10] ^= 1;
  const char *other_path = "Tel/2026 Novembre/VID_2.mp4";
  s = source(&m, other, blen);
  m.cancel_after_bytes = 12LL << 20;
  pgs_upload(c, &s, other_path, blen, 1, 1, &sent, err, sizeof(err));
  s = source(&m, big, blen);
  rc = pgs_upload(c, &s, other_path, blen, 1, 0, &sent, err, sizeof(err));
  printf(".part différent : reparti de %lld (rc=%d), identique=%d\n", (long long)m.first, rc,
         same_on_disk(other_path, big, blen));
  // Même original mais octets différents avant les 64 derniers Ko : reprise refusée au contrôle.
  s = source(&m, other, blen);
  m.cancel_after_bytes = 12LL << 20;
  pgs_upload(c, &s, "Tel/2026 Novembre/VID_3.mp4", blen, 1, 1, &sent, err, sizeof(err));
  uint8_t *third = malloc((size_t)blen);
  memcpy(third, other, (size_t)blen);
  long long cut = disk_size("Tel/2026 Novembre/VID_3.mp4.part");
  third[cut - 1000] ^= 1; // dans les 64 derniers Ko écrits : le contrôle doit le voir
  s = source(&m, third, blen);
  rc = pgs_upload(c, &s, "Tel/2026 Novembre/VID_3.mp4", blen, 1, 1, &sent, err, sizeof(err));
  printf("fin du .part différente : reparti de %lld (rc=%d), identique=%d\n", (long long)m.first, rc,
         same_on_disk("Tel/2026 Novembre/VID_3.mp4", third, blen));

  // Un petit fichier coupé ne laisse pas de .part (moins de 8 Mo : on recommence).
  s = source(&m, data, len);
  m.cancel_after_calls = 3;
  rc = pgs_upload(c, &s, "Tel/2026 Novembre/IMG_3.jpg", len, 1, 1, &sent, err, sizeof(err));
  printf("petit fichier coupé (rc=%d), .part restant=%d\n", rc, exists("Tel/2026 Novembre/IMG_3.jpg.part"));

  // Taille annoncée fausse : refus, pas de faux fichier fini.
  s = source(&m, data, len);
  rc = pgs_upload(c, &s, "Tel/2026 Novembre/IMG_4.jpg", len + 5, 1, 0, &sent, err, sizeof(err));
  printf("taille fausse : rc=%d (%s), fichier=%d part=%d\n", rc, err, exists("Tel/2026 Novembre/IMG_4.jpg"),
         exists("Tel/2026 Novembre/IMG_4.jpg.part"));

  // Noms avec accents et espaces.
  s = source(&m, data, 1000);
  rc = pgs_upload(c, &s, "Tel/2026 Février/Été à la mer (1).jpg", 1000, 1, 0, &sent, err, sizeof(err));
  if (rc == PGS_UNREACHABLE) printf("?");
  pgs_mkdirs(c, "Tel/2026 Février", err, sizeof(err));
  s = source(&m, data, 1000);
  rc = pgs_upload(c, &s, "Tel/2026 Février/Été à la mer (1).jpg", 1000, 1, 0, &sent, err, sizeof(err));
  printf("accents : rc=%d identique=%d\n", rc, same_on_disk("Tel/2026 Février/Été à la mer (1).jpg", data, 1000));
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
