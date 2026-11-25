"""Serveur SMB de test (impacket) pour le banc d'essai iPhone.

impacket répond à certaines erreurs (mot de passe refusé, partage absent, dossier qui existe
déjà) avec la réponse normale de la commande au lieu d'une réponse d'erreur SMB2. Windows et
Samba envoient une vraie réponse d'erreur, que libsmb2 attend : on corrige ça ici, au vol.

Usage : smbserver.py PARTAGE DOSSIER [port] [lecture-seule]
"""
import sys

from impacket import smbserver
from impacket import smb3structs as smb2
from impacket.nt_errors import STATUS_BUFFER_OVERFLOW, STATUS_MORE_PROCESSING_REQUIRED, STATUS_SUCCESS
from impacket.ntlm import compute_lmhash, compute_nthash

FINE = {STATUS_SUCCESS, STATUS_MORE_PROCESSING_REQUIRED, STATUS_BUFFER_OVERFLOW}


def proper_errors(handler):
    def wrapped(conn_id, server, packet):
        commands, packets, code = handler(conn_id, server, packet)
        if code not in FINE:
            if commands:
                commands = [smb2.SMB2Error() for _ in commands]
            for p in packets or []:
                p['Data'] = smb2.SMB2Error()  # signé à nouveau juste avant l'envoi
        return commands, packets, code

    return wrapped


def main():
    share, path = sys.argv[1], sys.argv[2]
    port = int(sys.argv[3]) if len(sys.argv) > 3 else 4445
    read_only = len(sys.argv) > 4 and sys.argv[4] == 'ro'
    server = smbserver.SimpleSMBServer(listenAddress='127.0.0.1', listenPort=port)
    server.addShare(share.upper(), path, '', readOnly='yes' if read_only else 'no')
    server.setSMB2Support(True)
    server.addCredential('test', 0, compute_lmhash('test'), compute_nthash('test'))
    inner = server._SimpleSMBServer__server
    table = inner._SMBSERVER__smb2Commands
    for command in list(table):
        table[command] = proper_errors(table[command])
    server.start()


if __name__ == '__main__':
    main()
