// Recopie tools/PixelGuard-PC.cmd dans src/prepScript.ts : l'appli le donne elle-même au PC
// (petit serveur web sur le Wi-Fi). À relancer après chaque modification du fichier :
//   npm run embed-prep        (les tests vérifient que les deux sont identiques)
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const script = fs.readFileSync(path.join(root, 'tools/PixelGuard-PC.cmd'), 'utf8');
// Empreinte des octets servis (UTF-8) : la ligne du Terminal la contrôle avant de lancer quoi que ce
// soit, et le téléphone en montre le début.
const sha = require('crypto').createHash('sha256').update(Buffer.from(script, 'utf8')).digest('hex');
const out =
  '// Généré par scripts/embed-prep.js depuis tools/PixelGuard-PC.cmd : ne pas modifier à la main.\n' +
  `export const PREP_SCRIPT = ${JSON.stringify(script)};\n` +
  `export const PREP_SHA256 = ${JSON.stringify(sha)};\n`;
fs.writeFileSync(path.join(root, 'src/prepScript.ts'), out);
console.log(`src/prepScript.ts : ${script.length} caractères`);
