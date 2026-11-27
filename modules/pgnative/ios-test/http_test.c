// Le petit serveur de l'iPhone (PgHttp.c), testé avec curl sur le Mac.
#include <arpa/inet.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>
#include "../ios/PgHttp.h"

static char *slurp(const char *path, size_t *len) {
  FILE *f = fopen(path, "rb");
  if (!f) return NULL;
  fseek(f, 0, SEEK_END);
  *len = (size_t)ftell(f);
  fseek(f, 0, SEEK_SET);
  char *b = malloc(*len);
  fread(b, 1, *len, f);
  fclose(f);
  return b;
}

static void run(const char *label, const char *cmd) {
  char line[512];
  FILE *p = popen(cmd, "r");
  printf("%s :", label);
  while (p && fgets(line, sizeof(line), p)) printf(" %s", strtok(line, "\r\n") ? line : "");
  printf("\n");
  if (p) pclose(p);
}

static double now(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return t.tv_sec + t.tv_nsec / 1e9;
}

/** Un client qui se connecte et n'envoie rien. */
static int silent_client(const char *ip, int port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  struct sockaddr_in a;
  memset(&a, 0, sizeof(a));
  a.sin_family = AF_INET;
  a.sin_port = htons((uint16_t)port);
  inet_pton(AF_INET, ip, &a.sin_addr);
  if (connect(fd, (struct sockaddr *)&a, sizeof(a)) < 0) {
    close(fd);
    return -1;
  }
  return fd;
}

static void *start_stop(void *arg) {
  (void)arg;
  char ip[64];
  for (int i = 0; i < 20; i++) {
    pgh_start(8800, ip, sizeof(ip));
    pgh_stop();
  }
  return NULL;
}

int main(int argc, char **argv) {
  (void)argc;
  size_t len = 0;
  char *cmd = slurp(argv[1], &len);
  const char *html = "<h1>PixelGuard</h1>";
  pgh_clear();
  printf("type ou nom avec guillemet, CR ou LF refusés : %s\n",
         pgh_add("/x", "text/plain\r\nX-Evil: 1", NULL, (const uint8_t *)"x", 1) < 0 &&
                 pgh_add("/x", "text/plain", "a\".cmd", (const uint8_t *)"x", 1) < 0 &&
                 pgh_add("/x", "text/plain", "a\n.cmd", (const uint8_t *)"x", 1) < 0
             ? "ok"
             : "ACCEPTÉS");
  pgh_add("/", "text/html; charset=utf-8", NULL, (const uint8_t *)html, strlen(html));
  pgh_add("/PixelGuard-PC.cmd", "application/octet-stream", "PixelGuard-PC.cmd", (const uint8_t *)cmd, len);
  pgh_add("/pg", "text/plain; charset=utf-8", "", (const uint8_t *)cmd, len);
  char ip[64] = "";
  int port = pgh_start(8800, ip, sizeof(ip));
  if (port < 0) {
    printf("pas d'adresse Wi-Fi (en0) sur ce Mac : serveur non testé\n");
    free(cmd);
    return 0;
  }
  char wifi[64];
  pgh_local_ipv4(wifi, sizeof(wifi));
  printf("port %d, adresse rendue %s (en0 du Mac : %s)\n", port, ip, strcmp(ip, wifi) == 0 ? "identique" : "DIFFÉRENTE");
  char c[768];
  snprintf(c, sizeof(c), "curl -s 'http://%s:%d/?x=1'", ip, port);
  run("page", c);
  snprintf(c, sizeof(c), "curl -s -o /tmp/pgh.cmd -D - http://%s:%d/PixelGuard-PC.cmd | grep -i disposition; cmp -s /tmp/pgh.cmd '%s' && echo identique || echo DIFFERENT; rm -f /tmp/pgh.cmd", ip, port, argv[1]);
  run("fichier", c);
  snprintf(c, sizeof(c), "curl -s -I http://%s:%d/pg | head -1", ip, port);
  run("HEAD", c);
  snprintf(c, sizeof(c), "curl -s -o /dev/null -w '%%{http_code}' http://%s:%d/etc/passwd; echo; curl -s -o /dev/null -w '%%{http_code}' -X POST http://%s:%d/", ip, port, ip, port);
  run("inconnu puis POST", c);
  snprintf(c, sizeof(c), "curl -s -m 2 -o /dev/null -w '%%{http_code}' http://127.0.0.1:%d/ || true", port);
  run("sur 127.0.0.1 (000 = n'écoute pas)", c);

  // Un client qui ne dit rien occupe le serveur 5 s au plus, pas indéfiniment.
  int slow = silent_client(ip, port);
  double t = now();
  snprintf(c, sizeof(c), "curl -s -m 15 -o /dev/null -w '%%{http_code}' http://%s:%d/", ip, port);
  run("après un client muet", c);
  printf("servi en %.1f s (5 s au plus attendu)\n", now() - t);
  if (slow >= 0) close(slow);

  // L'arrêt n'attend pas un client muet.
  slow = silent_client(ip, port);
  usleep(100 * 1000);
  t = now();
  pgh_stop();
  printf("arrêt avec un client muet : %.2f s\n", now() - t);
  if (slow >= 0) close(slow);
  pgh_stop(); // deux fois : sans effet
  snprintf(c, sizeof(c), "curl -s -m 2 -o /dev/null -w '%%{http_code}' http://%s:%d/ || true", ip, port);
  run("après arrêt (000 = fermé)", c);

  // Démarrer et arrêter depuis plusieurs fils à la fois : ni double fermeture, ni blocage.
  pthread_t th[4];
  for (int i = 0; i < 4; i++) pthread_create(&th[i], NULL, start_stop, NULL);
  for (int i = 0; i < 4; i++) pthread_join(th[i], NULL);
  pgh_stop();
  printf("démarrer et arrêter depuis 4 fils : ok\n");
  free(cmd);
  return 0;
}
