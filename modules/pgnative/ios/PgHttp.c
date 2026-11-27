// Voir PgHttp.h. Une requête à la fois, GET ou HEAD de quelques pages connues, rien d'autre.
#include "PgHttp.h"

#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <ifaddrs.h>
#include <net/if.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

typedef struct {
  char *path, *type, *download;
  uint8_t *body;
  size_t len;
} pgh_page;

#define PGH_MAX 8
/** Une requête a ce temps-là en tout (lire la demande, envoyer la réponse), pas plus. */
#define PGH_REQUEST_MS 5000
/** On attend par tranches courtes, pour voir vite l'arrêt du serveur. */
#define PGH_SLICE_MS 200

static pgh_page pages[PGH_MAX];
static int npages = 0;
static pthread_mutex_t lock = PTHREAD_MUTEX_INITIALIZER; // les pages
static pthread_mutex_t ctl = PTHREAD_MUTEX_INITIALIZER;  // démarrer et arrêter, un seul à la fois
static int listen_fd = -1;  // sous ctl
static int started = 0;     // sous ctl : un fil tourne et devra être attendu une fois
static pthread_t thread;    // sous ctl
static atomic_int running = 0;

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

/** Rien qui puisse casser un en-tête : ni guillemet, ni retour à la ligne, ni caractère de contrôle. */
static int header_safe(const char *s) {
  for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
    if (*p == '"' || *p == '\r' || *p == '\n' || *p < 0x20 || *p == 0x7f) return 0;
  }
  return 1;
}

int pgh_add(const char *path, const char *type, const char *download, const uint8_t *body, size_t len) {
  if (path == NULL || type == NULL || !header_safe(type)) return -1;
  if (download != NULL && !header_safe(download)) return -1;
  if (len > 0 && body == NULL) return -1;
  pthread_mutex_lock(&lock);
  if (npages >= PGH_MAX) {
    pthread_mutex_unlock(&lock);
    return -1;
  }
  pgh_page p;
  p.path = strdup(path);
  p.type = strdup(type);
  p.download = (download && *download) ? strdup(download) : NULL;
  p.body = malloc(len ? len : 1);
  p.len = len;
  if (!p.path || !p.type || !p.body || (download && *download && !p.download)) {
    free(p.path);
    free(p.type);
    free(p.download);
    free(p.body);
    pthread_mutex_unlock(&lock);
    return -1;
  }
  if (len) memcpy(p.body, body, len);
  pages[npages++] = p;
  pthread_mutex_unlock(&lock);
  return 0;
}

static double now_ms(void) {
  struct timespec t;
  clock_gettime(CLOCK_MONOTONIC, &t);
  return (double)t.tv_sec * 1000.0 + (double)t.tv_nsec / 1e6;
}

/** Attend que `fd` soit prêt avant `deadline`. 0 si le délai passe ou si le serveur s'arrête. */
static int wait_fd(int fd, short events, double deadline) {
  while (atomic_load(&running)) {
    double left = deadline - now_ms();
    if (left <= 0) return 0;
    struct pollfd p = {.fd = fd, .events = events};
    int r = poll(&p, 1, left < PGH_SLICE_MS ? (int)left + 1 : PGH_SLICE_MS);
    if (r > 0) return 1;
    if (r < 0 && errno != EINTR) return 0;
  }
  return 0;
}

static int send_all(int fd, const void *buf, size_t len, double deadline) {
  const char *p = buf;
  while (len > 0) {
    if (!wait_fd(fd, POLLOUT, deadline)) return -1;
    ssize_t n = send(fd, p, len, 0);
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) continue;
    if (n <= 0) return -1;
    p += n;
    len -= (size_t)n;
  }
  return 0;
}

/** Les en-têtes d'une réponse, sans jamais déborder du tampon. */
typedef struct {
  char buf[1024];
  size_t len;
  int over;
} headers;

static void hadd(headers *h, const char *fmt, ...) {
  if (h->over) return;
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(h->buf + h->len, sizeof(h->buf) - h->len, fmt, ap);
  va_end(ap);
  if (n < 0 || (size_t)n >= sizeof(h->buf) - h->len) {
    h->over = 1;
    return;
  }
  h->len += (size_t)n;
}

static void respond(int fd) {
  double deadline = now_ms() + PGH_REQUEST_MS;
  char head[8192];
  size_t got = 0;
  head[0] = 0;
  // Les en-têtes jusqu'à la ligne vide (8 Ko au plus) : seule la première ligne compte.
  while (got < sizeof(head) - 1) {
    if (!wait_fd(fd, POLLIN, deadline)) return; // client trop lent, ou arrêt : rien à répondre
    ssize_t n = recv(fd, head + got, sizeof(head) - 1 - got, 0);
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)) continue;
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
  headers h = {.len = 0, .over = 0};
  pthread_mutex_lock(&lock);
  pgh_page *page = NULL;
  for (int i = 0; (get || headonly) && i < npages; i++) {
    if (strcmp(pages[i].path, path) == 0) page = &pages[i];
  }
  if (!get && !headonly) {
    hadd(&h, "HTTP/1.1 405 Method Not Allowed\r\nAllow: GET, HEAD\r\nContent-Length: 0\r\n");
  } else if (!page) {
    hadd(&h, "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n");
  } else {
    hadd(&h, "HTTP/1.1 200 OK\r\nContent-Type: %s\r\n", page->type);
    if (page->download) hadd(&h, "Content-Disposition: attachment; filename=\"%s\"\r\n", page->download);
    hadd(&h, "Content-Length: %zu\r\n", page->len);
  }
  hadd(&h, "Cache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n");
  if (h.over) {
    // Un type ou un nom trop long : on ne coupe pas un en-tête au milieu.
    static const char err500[] = "HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    send_all(fd, err500, sizeof(err500) - 1, deadline);
  } else if (send_all(fd, h.buf, h.len, deadline) == 0 && page && get) {
    send_all(fd, page->body, page->len, deadline);
  }
  pthread_mutex_unlock(&lock);
}

static void *loop(void *arg) {
  int lfd = (int)(intptr_t)arg;
  while (atomic_load(&running)) {
    struct pollfd p = {.fd = lfd, .events = POLLIN};
    int r = poll(&p, 1, PGH_SLICE_MS);
    if (r <= 0) continue;
    int c = accept(lfd, NULL, NULL);
    if (c < 0) continue;
    int one = 1;
    setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &one, sizeof(one));
    fcntl(c, F_SETFL, fcntl(c, F_GETFL) | O_NONBLOCK);
    respond(c);
    close(c);
  }
  return NULL;
}

static int is_private(uint32_t ip) { return (ip >> 24) == 10 || (ip >> 20) == 0xAC1 || (ip >> 16) == 0xC0A8; }

/** L'adresse IPv4 privée du Wi-Fi (en0). -1 s'il n'en a pas. */
static int wifi_ipv4(struct in_addr *out) {
  struct ifaddrs *list = NULL;
  if (getifaddrs(&list) != 0) return -1;
  int found = -1;
  for (struct ifaddrs *i = list; i; i = i->ifa_next) {
    if (!i->ifa_addr || i->ifa_addr->sa_family != AF_INET || !(i->ifa_flags & IFF_UP)) continue;
    if (strcmp(i->ifa_name, "en0") != 0) continue;
    struct in_addr a = ((struct sockaddr_in *)i->ifa_addr)->sin_addr;
    if (!is_private(ntohl(a.s_addr))) continue;
    *out = a;
    found = 0;
    break;
  }
  freeifaddrs(list);
  return found;
}

static int bind_port(struct in_addr addr, int port) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return -1;
  int one = 1;
  setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
  struct sockaddr_in a;
  memset(&a, 0, sizeof(a));
  a.sin_family = AF_INET;
  a.sin_addr = addr; // le Wi-Fi seulement, pas les autres cartes (VPN, partage de connexion...)
  a.sin_port = htons((uint16_t)port);
  if (bind(fd, (struct sockaddr *)&a, sizeof(a)) < 0 || listen(fd, 8) < 0) {
    close(fd);
    return -1;
  }
  fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
  return fd;
}

/** Sous ctl. Le fil voit l'arrêt en 200 ms au plus, même au milieu d'une requête. */
static void stop_locked(void) {
  if (!started) return;
  atomic_store(&running, 0);
  pthread_join(thread, NULL);
  close(listen_fd);
  listen_fd = -1;
  started = 0;
}

int pgh_start(int port, char *ip, size_t iplen) {
  if (ip && iplen) ip[0] = 0;
  pthread_mutex_lock(&ctl);
  stop_locked();
  struct in_addr addr;
  if (wifi_ipv4(&addr) != 0) {
    pthread_mutex_unlock(&ctl);
    return -1;
  }
  int fd = bind_port(addr, port);
  if (fd < 0) fd = bind_port(addr, 0);
  if (fd < 0) {
    pthread_mutex_unlock(&ctl);
    return -1;
  }
  struct sockaddr_in a;
  socklen_t alen = sizeof(a);
  getsockname(fd, (struct sockaddr *)&a, &alen);
  atomic_store(&running, 1);
  if (pthread_create(&thread, NULL, loop, (void *)(intptr_t)fd) != 0) {
    atomic_store(&running, 0);
    close(fd);
    pthread_mutex_unlock(&ctl);
    return -1;
  }
  listen_fd = fd;
  started = 1;
  if (ip && iplen) inet_ntop(AF_INET, &addr, ip, (socklen_t)iplen);
  pthread_mutex_unlock(&ctl);
  return ntohs(a.sin_port);
}

void pgh_stop(void) {
  pthread_mutex_lock(&ctl);
  stop_locked();
  pthread_mutex_unlock(&ctl);
}

void pgh_local_ipv4(char *out, size_t len) {
  if (!out || !len) return;
  out[0] = 0;
  struct in_addr a;
  if (wifi_ipv4(&a) == 0) inet_ntop(AF_INET, &a, out, (socklen_t)len);
}
