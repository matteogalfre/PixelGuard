#!/bin/sh
# Teste SmbCore.java sur l'ordinateur, contre un serveur SMB local (impacket), sans téléphone.
# Il faut Java 17 (JAVA_HOME ou dans le PATH) et Python 3. Les bibliothèques viennent de Maven Central et de PyPI.
set -e
cd "$(dirname "$0")"
W=.work
mkdir -p $W/jars $W/out $W/share
M=https://repo1.maven.org/maven2
for j in com/hierynomus/smbj/0.15.0/smbj-0.15.0.jar org/bouncycastle/bcprov-jdk18on/1.87/bcprov-jdk18on-1.87.jar \
         org/slf4j/slf4j-api/2.0.18/slf4j-api-2.0.18.jar com/hierynomus/asn-one/0.6.0/asn-one-0.6.0.jar \
         net/engio/mbassador/1.3.2/mbassador-1.3.2.jar; do
  [ -f $W/jars/$(basename $j) ] || curl -sfo $W/jars/$(basename $j) $M/$j
done
[ -d $W/venv ] || { python3 -m venv $W/venv && $W/venv/bin/pip install -q impacket; }
$W/venv/bin/python $W/venv/bin/smbserver.py -smb2support -port 4445 -ip 127.0.0.1 -username test -password test PHOTOS $W/share >/dev/null 2>&1 &
SERVER=$!
trap 'kill $SERVER' EXIT
i=0; until nc -z 127.0.0.1 4445 2>/dev/null || [ $i -ge 40 ]; do sleep 0.5; i=$((i+1)); done
rm -rf "$W/share/Tel"
CP=$(ls $W/jars/*.jar | tr '\n' ':')
SRC=../android/src/main/java/expo/modules/pgnative
"${JAVA_HOME:+$JAVA_HOME/bin/}javac" -d $W/out -cp "$CP" $SRC/SmbCore.java $SRC/HybridSecurityProvider.java CoreTest.java NbParse.java
"${JAVA_HOME:+$JAVA_HOME/bin/}java" -cp "$CP$W/out" CoreTest "$W/share" 2>&1 | grep -v SLF4J
"${JAVA_HOME:+$JAVA_HOME/bin/}java" -cp "$CP$W/out" NbParse
