[Setup]
AppName=PixelGuard
AppVersion=1.0
DefaultDirName={autopf}\PixelGuard
OutputBaseFilename=PixelGuardSetup
Compression=lzma
SolidCompression=yes
PrivilegesRequired=admin

[Files]
Source: "dist\photos.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "icons\PixelGuard.png"; DestDir: "{app}\icons"; Flags: ignoreversion
Source: "adb.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "AdbWinApi.dll"; DestDir: "{app}"; Flags: ignoreversion
Source: "AdbWinUsbApi.dll"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\PixelGuard"; Filename: "{app}\photos.exe"

[Run]
Filename: "{app}\photos.exe"; Description: "Lancer l'application"; Flags: postinstall skipifsilent
