// Draws the Codebit mark (the green </> used in the app) as build/icon.svg,
// build/icon.png (256 px) and build/icon.ico (16–256 px). Small sizes get a
// bigger, bolder glyph so it stays readable in the taskbar.
// Run with: npm run icon
import { app, BrowserWindow } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "build");
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
function svg(size) {
  const small = size <= 32;
  // Glyph box inside the 256 canvas and stroke width in lucide's 24 units.
  const pad = small ? 34 : 48;
  const stroke = size <= 20 ? 3.1 : small ? 2.7 : size <= 64 ? 2.3 : 2;
  const scale = (256 - pad * 2) / 24;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 256 256">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#1c2b24"/>
      <stop offset="1" stop-color="#0f1417"/>
    </linearGradient>
  </defs>
  <rect x="6" y="6" width="244" height="244" rx="${small ? 44 : 56}" fill="url(#bg)" stroke="#2f5a42" stroke-width="${small ? 0 : 3}"/>
  <g transform="translate(${pad} ${pad}) scale(${scale})" fill="none" stroke="#64ce8e" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">
    <path d="m18 16 4-4-4-4"/>
    <path d="m6 8-4 4 4 4"/>
    <path d="m14.5 4-5 16"/>
  </g>
</svg>`;
}
// ICO with PNG entries (supported since Windows Vista).
function ico(pngs) {
  const header = Buffer.alloc(6 + 16 * pngs.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(pngs.length, 4);
  let offset = header.length;
  pngs.forEach(({ size, data }, i) => {
    const e = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, e);
    header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt16LE(1, e + 4);
    header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(data.length, e + 8);
    header.writeUInt32LE(offset, e + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...pngs.map((p) => p.data)]);
}
app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false });
  await win.loadURL("data:text/html,<body></body>");
  const pngs = [];
  for (const size of sizes) {
    const url = await win.webContents
      .executeJavaScript(`new Promise((done, fail) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = c.height = ${size};
        c.getContext("2d").drawImage(img, 0, 0, ${size}, ${size});
        done(c.toDataURL("image/png"));
      };
      img.onerror = fail;
      img.src = "data:image/svg+xml;base64," + ${JSON.stringify(Buffer.from(svg(size)).toString("base64"))};
    })`);
    pngs.push({ size, data: Buffer.from(url.split(",")[1], "base64") });
  }
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "icon.svg"), svg(256));
  writeFileSync(join(out, "icon.png"), pngs.at(-1).data);
  writeFileSync(join(out, "icon.ico"), ico(pngs));
  console.log("ícone gerado em", out, pngs.map((p) => `${p.size}px`).join(" "));
  app.quit();
});
