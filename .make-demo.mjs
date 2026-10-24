import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const page = path.join(root, 'Sugan-Supermarket-Demo.html');
const bundle = path.join(root, '.demo-qr-build', 'qr-bundle.iife.js');
let html = fs.readFileSync(page, 'utf8');
const qr = fs.readFileSync(bundle, 'utf8');
// Prevent an internal </script sequence in the QR library from terminating
// the surrounding HTML script element. The JavaScript escape preserves value.
const safeQr = qr.replace(/<\/script/gi, '<\\/script');
// Replace the complete first inline script body, using the second script tag
// as the boundary. Searching for the old bundle text is fragile because a
// previous generated page may already contain the HTML-escaped bundle.
const qrScriptOpen = html.indexOf('<script>');
const appScriptOpen = html.indexOf('\n<script>', qrScriptOpen + '<script>'.length);
if (qrScriptOpen < 0 || appScriptOpen < 0) {
  throw new Error('Could not locate the demo QR and application script boundaries');
}
html = `${html.slice(0, qrScriptOpen + '<script>'.length)}${safeQr}</script>${html.slice(appScriptOpen)}`;
fs.writeFileSync(page, html, 'utf8');
console.log(`Wrote standalone demo: ${path.basename(page)} (${Buffer.byteLength(html)} bytes)`);
