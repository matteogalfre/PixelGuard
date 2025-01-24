from pymobiledevice3 import usbmux
from pymobiledevice3.lockdown import LockdownClient
from pymobiledevice3.services.afc import AfcService

def list_ios_files(path="/"):
    devices = usbmux.list_devices()
    if not devices:
        print("Aucun appareil iOS détecté.")
        return

    device = devices[0]
    lockdown = LockdownClient(device)
    afc = AfcService(lockdown)

    try:
        files = afc.listdir(path)
        print(f"Contenu du dossier {path}:")
        for file in files:
            file_info = afc.stat(f"{path}/{file}")
            file_type = "Dossier" if file_info.st_ifmt == "S_IFDIR" else "Fichier"
            print(f"- {file} ({file_type})")
    except Exception as e:
        print(f"Erreur lors de la lecture du dossier : {e}")

if __name__ == "__main__":
    list_ios_files()
