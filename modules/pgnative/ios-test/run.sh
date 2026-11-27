#!/bin/sh
# Teste PgSmb.c (le SMB de l'iPhone) sur le Mac, contre un serveur SMB local (impacket), sans iPhone.
# Il faut les outils de ligne de commande Xcode et Python 3. impacket vient de PyPI.
# Avec --serve, lance seulement le serveur (port 4445) pour essayer l'appli dans le simulateur.
set -e
cd "$(dirname "$0")"
W=.work
mkdir -p $W/out $W/share
[ -d $W/venv ] || { python3 -m venv $W/venv && $W/venv/bin/pip install -q impacket; }
if [ "$1" = "--serve" ]; then
  echo "Serveur SMB de test : 127.0.0.1:4445, partage PHOTOS, utilisateur test, mot de passe test"
  echo "Dossier partagé : $(pwd)/$W/share"
  exec $W/venv/bin/python -I smbserver.py PHOTOS $W/share 4445
fi
$W/venv/bin/python -I smbserver.py PHOTOS $W/share 4445 >/dev/null 2>&1 &
SERVER=$!
# Un second serveur, que le test coupe pour vérifier qu'une connexion fermée par le PC se voit.
$W/venv/bin/python -I smbserver.py PHOTOS $W/share 4446 >/dev/null 2>&1 &
SERVER2=$!
# Un troisième, que le test fige (SIGSTOP) en plein envoi : le PC ne répond plus du tout.
$W/venv/bin/python -I smbserver.py PHOTOS $W/share 4447 >/dev/null 2>&1 &
SERVER3=$!
trap 'kill -CONT $SERVER3 2>/dev/null; kill $SERVER $SERVER2 $SERVER3 2>/dev/null' EXIT
i=0; until { nc -z 127.0.0.1 4445 && nc -z 127.0.0.1 4446 && nc -z 127.0.0.1 4447; } 2>/dev/null || [ $i -ge 40 ]; do sleep 0.5; i=$((i+1)); done
rm -rf "$W/share/Tel"
L=../ios/libsmb2
FLAGS="-O2 -DHAVE_CONFIG_H=1 -D_U_=__attribute__((unused)) -I$L/include -I$L/include/apple -I$L/include/smb2 -I$L/lib"
# libsmb2 compilé une fois pour toutes, PgSmb.c à chaque fois.
if [ ! -f $W/out/libsmb2.a ]; then
  for f in $L/lib/*.c; do clang $FLAGS -w -c "$f" -o "$W/out/$(basename "$f" .c).o"; done
  ar rcs $W/out/libsmb2.a $W/out/*.o
fi
clang $FLAGS -Wall -Wextra -Wno-unused-parameter ../ios/PgSmb.c core_test.c $W/out/libsmb2.a -lpthread -o $W/out/core_test
$W/out/core_test "$W/share" $SERVER2 $SERVER3
# Le petit serveur qui donne « Prepare my PC » au navigateur du PC.
clang -Wall -Wextra -O2 ../ios/PgHttp.c http_test.c -lpthread -o $W/out/http_test
$W/out/http_test ../../../tools/PixelGuard-PC.cmd
