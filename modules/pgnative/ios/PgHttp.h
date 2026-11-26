// Un tout petit serveur web, le temps de préparer un PC : le téléphone donne lui-même le fichier
// « Prepare my PC » au navigateur du PC, sur le Wi-Fi. Même travail que MiniServer.java.
#ifndef PG_HTTP_H
#define PG_HTTP_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Oublie les pages d'avant (le serveur doit être arrêté). */
void pgh_clear(void);
/** Ajoute une page : chemin (« / »), type, nom de fichier à télécharger (NULL ou "" sinon). Copiée. */
int pgh_add(const char *path, const char *type, const char *download, const uint8_t *body, size_t len);
/** Démarre sur `port` s'il est libre, sinon sur un port au hasard. Renvoie le port, ou -1. */
int pgh_start(int port);
void pgh_stop(void);
/** L'adresse IPv4 du téléphone sur le Wi-Fi (en0 d'abord), "" si aucune. */
void pgh_local_ipv4(char *out, size_t len);

#ifdef __cplusplus
}
#endif

#endif
