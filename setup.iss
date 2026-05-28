; PixelGuard - Inno Setup script

#define MyAppName        "PixelGuard"
#define MyAppVersion     "2.0.0"
#define MyAppPublisher   "Mattéo"
#define MyAppExeName     "photos.exe"
#define MyAppId          "{{F2A6E5A0-9B4F-4C3D-B0E2-7E54F0D2C9A2}"

[Setup]
AppId={#MyAppId}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
VersionInfoVersion={#MyAppVersion}
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
OutputBaseFilename={#MyAppName}Setup-{#MyAppVersion}
Compression=lzma2/ultra
SolidCompression=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesInstallIn64BitMode=x64
WizardStyle=modern
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\{#MyAppExeName}
SetupIconFile=PixelGuard.ico
CloseApplications=force
RestartApplications=no

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"

[Files]
Source: "dist\photos.exe";       DestDir: "{app}";       Flags: ignoreversion
Source: "icons\PixelGuard.png";  DestDir: "{app}\icons"; Flags: ignoreversion
Source: "icons\folder.png";      DestDir: "{app}\icons"; Flags: ignoreversion
Source: "adb.exe";               DestDir: "{app}";       Flags: ignoreversion
Source: "AdbWinApi.dll";         DestDir: "{app}";       Flags: ignoreversion
Source: "AdbWinUsbApi.dll";      DestDir: "{app}";       Flags: ignoreversion

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Tasks]
Name: "desktopicon"; Description: "Créer un raccourci sur le Bureau"; \
    GroupDescription: "Raccourcis :"

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Lancer {#MyAppName}"; \
    Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}"
