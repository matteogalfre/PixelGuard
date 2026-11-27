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
/**
 * Ajoute une page : chemin (« / »), type, nom de fichier à télécharger (NULL ou "" sinon). Copiée.
 * -1 si `type` ou `download` contient un guillemet, un retour à la ligne ou un caractère de
 * contrôle (ils iraient tels quels dans les en-têtes), ou s'il y a déjà 8 pages.
 */
int pgh_add(const char *path, const char *type, const char *download, const uint8_t *body, size_t len);
/**
 * Démarre sur `port` s'il est libre, sinon sur un port au hasard, en écoutant seulement sur
 * l'adresse IPv4 du Wi-Fi (en0), écrite dans `ip`. Renvoie le port, ou -1 (pas de Wi-Fi).
 * Démarrer et arrêter peuvent venir de fils différents : ils passent un par un.
 */
int pgh_start(int port, char *ip, size_t iplen);
/** Arrête le serveur, même au milieu d'une requête (200 ms au plus). Sans effet s'il est arrêté. */
void pgh_stop(void);
/** L'adresse IPv4 privée du téléphone sur le Wi-Fi (en0), "" si aucune. */
void pgh_local_ipv4(char *out, size_t len);

#ifdef __cplusplus
}
#endif

#endif
