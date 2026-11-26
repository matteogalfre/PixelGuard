// Le petit serveur de l'iPhone (PgHttp.c), testé avec curl sur le Mac.
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
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

int main(int argc, char **argv) {
  (void)argc;
  size_t len = 0;
  char *cmd = slurp(argv[1], &len);
  const char *html = "<h1>PixelGuard</h1>";
  pgh_clear();
  pgh_add("/", "text/html; charset=utf-8", NULL, (const uint8_t *)html, strlen(html));
  pgh_add("/PixelGuard-PC.cmd", "application/octet-stream", "PixelGuard-PC.cmd", (const uint8_t *)cmd, len);
  pgh_add("/pg", "text/plain; charset=utf-8", "", (const uint8_t *)cmd, len);
  int port = pgh_start(8800);
  char ip[64];
  pgh_local_ipv4(ip, sizeof(ip));
  printf("port %d, adresse (ici le Mac) %s\n", port, ip);
  char c[512];
  snprintf(c, sizeof(c), "curl -s 'http://127.0.0.1:%d/?x=1'", port);
  run("page", c);
  snprintf(c, sizeof(c), "curl -s -o /tmp/pgh.cmd -D - http://127.0.0.1:%d/PixelGuard-PC.cmd | grep -i disposition; cmp -s /tmp/pgh.cmd '%s' && echo identique || echo DIFFERENT; rm -f /tmp/pgh.cmd", port, argv[1]);
  run("fichier", c);
  snprintf(c, sizeof(c), "curl -s -I http://127.0.0.1:%d/pg | head -1", port);
  run("HEAD", c);
  snprintf(c, sizeof(c), "curl -s -o /dev/null -w '%%{http_code}' http://127.0.0.1:%d/etc/passwd; echo; curl -s -o /dev/null -w '%%{http_code}' -X POST http://127.0.0.1:%d/", port, port);
  run("inconnu puis POST", c);
  pgh_stop();
  snprintf(c, sizeof(c), "curl -s -m 2 -o /dev/null -w '%%{http_code}' http://127.0.0.1:%d/ || true", port);
  run("après arrêt (000 = fermé)", c);
  free(cmd);
  return 0;
}
