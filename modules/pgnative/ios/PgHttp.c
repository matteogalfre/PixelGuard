// Voir PgHttp.h. Une requête à la fois, GET ou HEAD de quelques pages connues, rien d'autre.
#include "PgHttp.h"

#include <arpa/inet.h>
#include <errno.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

typedef struct {
  char *path, *type, *download;
  uint8_t *body;
  size_t len;
} pgh_page;

#define PGH_MAX 8
static pgh_page pages[PGH_MAX];
static int npages = 0;
static int listen_fd = -1;
static volatile int running = 0;
static pthread_t thread;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER;

void pgh_clear(void) {
  pthread_mutex_lock(&lock);
  for (int i = 0; i < npages; i++) {
    free(pages[i].path);
    free(pages[i].type);
    free(pages[i].download);
    free(pages[i].body);
  }
  npages = 0;
  pthread_mutex_unlock(&lock);
}

int pgh_add(const char *path, const char *type, const char *download, const uint8_t *body, size_t len) {
  pthread_mutex_lock(&lock);
  if (npages >= PGH_MAX) {
    pthread_mutex_unlock(&lock);
    return -1;
  }
  pgh_page *p = &pages[npages++];
  p->path = strdup(path);
  p->type = strdup(type);
  p->download = (download && *download) ? strdup(download) : NULL;
  p->body = malloc(len ? len : 1);
  if (len) memcpy(p->body, body, len);
  p->len = len;
  pthread_mutex_unlock(&lock);
  return 0;
}

static void send_all(int fd, const void *buf, size_t len) {
  const char *p = buf;
  while (len > 0) {
    ssize_t n = send(fd, p, len, 0);
    if (n <= 0) return;
    p += n;
    len -= (size_t)n;
  }
}

static void respond(int fd) {
  char head[8192];
  size_t got = 0;
  // Les en-têtes jusqu'à la ligne vide (8 Ko au plus) : seule la première ligne compte.
  while (got < sizeof(head) - 1) {
    ssize_t n = recv(fd, head + got, sizeof(head) - 1 - got, 0);
    if (n <= 0) break;
    got += (size_t)n;
    head[got] = 0;
    if (strstr(head, "\r\n\r\n")) break;
  }
  head[got] = 0;
  char method[8] = "", path[512] = "";
  sscanf(head, "%7s %511s", method, path);
  char *q = strchr(path, '?');
  if (q) *q = 0;
  int get = strcmp(method, "GET") == 0, headonly = strcmp(method, "HEAD") == 0;
  char hdr[1024];
  pthread_mutex_lock(&lock);
  pgh_page *page = NULL;
  for (int i = 0; (get || headonly) && i < npages; i++) {
    if (strcmp(pages[i].path, path) == 0) page = &pages[i];
  }
  int n;
  if (!get && !headonly) {
    n = snprintf(hdr, sizeof(hdr), "HTTP/1.1 405 Method Not Allowed\r\nAllow: GET, HEAD\r\nContent-Length: 0\r\n");
  } else if (!page) {
    n = snprintf(hdr, sizeof(hdr), "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n");
  } else {
    n = snprintf(hdr, sizeof(hdr), "HTTP/1.1 200 OK\r\nContent-Type: %s\r\n", page->type);
    if (page->download) {
      n += snprintf(hdr + n, sizeof(hdr) - n, "Content-Disposition: attachment; filename=\"%s\"\r\n", page->download);
    }
    n += snprintf(hdr + n, sizeof(hdr) - n, "Content-Length: %zu\r\n", page->len);
  }
  n += snprintf(hdr + n, sizeof(hdr) - n, "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n");
  send_all(fd, hdr, (size_t)n);
  if (page && get) send_all(fd, page->body, page->len);
  pthread_mutex_unlock(&lock);
}

static void *loop(void *arg) {
  (void)arg;
  while (running) {
    int c = accept(listen_fd, NULL, NULL);
    if (c < 0) {
      if (!running) break;
      continue;
    }
    struct timeval tv = {5, 0};
    setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(c, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
    int one = 1;
    setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
    respond(c);
    close(c);
  }
  return NULL;
}

static int bind_port(int port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
  struct sockaddr_in a;
  memset(&a, 0, sizeof(a));
  a.sin_family = AF_INET;
  a.sin_addr.s_addr = htonl(INADDR_ANY);
  a.sin_port = htons((uint16_t)port);
  if (bind(fd, (struct sockaddr *)&a, sizeof(a)) < 0 || listen(fd, 8) < 0) {
    close(fd);
    return -1;
  }
  return fd;
}

int pgh_start(int port) {
  pgh_stop();
  int fd = bind_port(port);
  if (fd < 0) fd = bind_port(0);
  if (fd < 0) return -1;
  struct sockaddr_in a;
  socklen_t alen = sizeof(a);
  getsockname(fd, (struct sockaddr *)&a, &alen);
  listen_fd = fd;
  running = 1;
  if (pthread_create(&thread, NULL, loop, NULL) != 0) {
    running = 0;
    close(fd);
    listen_fd = -1;
    return -1;
  }
  return ntohs(a.sin_port);
}

void pgh_stop(void) {
  if (!running) return;
  running = 0;
  // Débloque accept() : le fil s'arrête, puis on ferme.
  shutdown(listen_fd, SHUT_RDWR);
  close(listen_fd);
  pthread_join(thread, NULL);
  listen_fd = -1;
}

void pgh_local_ipv4(char *out, size_t len) {
  if (!out || !len) return;
  out[0] = 0;
  struct ifaddrs *list = NULL;
  if (getifaddrs(&list) != 0) return;
  for (int pass = 0; pass < 2 && !out[0]; pass++) {
    for (struct ifaddrs *i = list; i; i = i->ifa_next) {
      if (!i->ifa_addr || i->ifa_addr->sa_family != AF_INET || !(i->ifa_flags & IFF_UP) || (i->ifa_flags & IFF_LOOPBACK)) continue;
      // Le Wi-Fi (en0) d'abord, puis n'importe quelle carte locale.
      if (pass == 0 && strcmp(i->ifa_name, "en0") != 0) continue;
      uint32_t ip = ntohl(((struct sockaddr_in *)i->ifa_addr)->sin_addr.s_addr);
      int priv = (ip >> 24) == 10 || (ip >> 20) == 0xAC1 || (ip >> 16) == 0xC0A8;
      if (!priv) continue;
      inet_ntop(AF_INET, &((struct sockaddr_in *)i->ifa_addr)->sin_addr, out, (socklen_t)len);
      break;
    }
  }
  freeifaddrs(list);
}
