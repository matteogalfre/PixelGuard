import { useEffect, useState } from 'react';

import { lang, t } from './i18n';
import { Pg } from './native';
import { PREP_SCRIPT, PREP_SHA256 } from './prepScript';

/** Le début de l'empreinte du fichier, à comparer entre le téléphone et le PC (« 3f2a 9c01 77be »). */
export const prepFingerprint = PREP_SHA256.slice(0, 12).replace(/(.{4})(?=.)/g, '$1 ');

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** La page que le navigateur du PC ouvre : un gros bouton, trois étapes, la commande en secours. */
function page(): string {
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>PixelGuard</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0E0B1E;color:#F2F6FA;font-family:"Segoe UI",system-ui,sans-serif}
main{max-width:560px;padding:32px}
h1{font-size:30px;margin:0 0 24px}
a.btn{display:inline-block;background:#6A55F5;color:#fff;text-decoration:none;font-size:20px;font-weight:600;padding:16px 28px;border-radius:14px}
ol{font-size:18px;line-height:1.7;padding-left:22px;margin:24px 0}
pre{background:rgba(255,255,255,.08);padding:12px;border-radius:10px;font-size:14px;white-space:pre-wrap;word-break:break-all}
button{font-size:15px;padding:8px 16px;border-radius:10px;border:1px solid rgba(255,255,255,.25);background:none;color:#F2F6FA;cursor:pointer}
p{color:#B8C2CE}small{display:block;margin-top:28px;color:#8B98A8}
</style></head><body><main>
<h1>${escape(t.srvTitle)}</h1>
<a class="btn" href="/PixelGuard-PC.cmd" download>${escape(t.srvDownload)}</a>
<ol><li>${escape(t.srvStep1)}</li><li>${escape(t.srvStep2)}</li><li>${escape(t.srvStep3)}</li></ol>
<p>${escape(t.srvAlt)}</p><pre id="cmd"></pre><button id="copy">${escape(t.srvCopy)}</button>
<p>${escape(t.srvPrint(prepFingerprint))}</p>
<small>${escape(t.srvFoot)}</small>
</main><script>
// Le fichier est lu en octets, son empreinte contrôlée, et seulement ensuite lancé : un fichier
// modifié en route sur le réseau n'est pas exécuté.
var c = "$b=(New-Object Net.WebClient).DownloadData('http://" + location.host + "/pg');" +
  "if((-join([Security.Cryptography.SHA256]::Create().ComputeHash($b)|%{$_.ToString('x2')})) -eq '${PREP_SHA256}')" +
  "{iex ([Text.Encoding]::UTF8.GetString($b))}else{'PixelGuard : fichier different, rien lance.'}";
document.getElementById('cmd').textContent = c;
document.getElementById('copy').onclick = function () {
  var x = document.createElement('textarea'); x.value = c; document.body.appendChild(x); x.select();
  document.execCommand('copy'); x.remove(); this.textContent = ${JSON.stringify(t.srvCopied)};
};
</script></body></html>`;
}

/**
 * Pendant que `active` est vrai, le téléphone propose « Prepare my PC » sur le Wi-Fi. Renvoie
 * l'adresse à ouvrir sur le PC (« 192.168.1.42:8800 »), ou null si ce n'est pas possible
 * (pas de Wi-Fi, aperçu web) : l'écran garde alors le lien GitHub.
 */
export function usePrepServer(active: boolean): string | null {
  const [address, setAddress] = useState<string | null>(null);
  useEffect(() => {
    if (!active || !Pg.startPrepServer) return;
    let live = true;
    Pg.startPrepServer([
      { path: '/', type: 'text/html; charset=utf-8', body: page(), download: '' },
      { path: '/PixelGuard-PC.cmd', type: 'application/octet-stream', body: PREP_SCRIPT, download: 'PixelGuard-PC.cmd' },
      // Pour « irm … | iex » dans le Terminal : du texte, pas un téléchargement.
      { path: '/pg', type: 'text/plain; charset=utf-8', body: PREP_SCRIPT, download: '' },
    ])
      .then(({ ip, port }) => {
        if (live && ip) setAddress(port === 80 ? ip : `${ip}:${port}`);
      })
      .catch(() => {});
    return () => {
      live = false;
      setAddress(null);
      Pg.stopPrepServer?.().catch(() => {});
    };
  }, [active]);
  return address;
}
