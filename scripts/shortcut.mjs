// Creates a desktop shortcut that opens Codebit from this folder (modo
// código): the app builds itself when src changes, with no packaging.
// Run with: npm run shortcut
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const quote = (s) => `'${s.replaceAll("'", "''")}'`;
const script = `
$shell = New-Object -ComObject WScript.Shell
$path = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Codebit.lnk'
$link = $shell.CreateShortcut($path)
$link.TargetPath = ${quote(join(root, "node_modules", "electron", "dist", "electron.exe"))}
$link.Arguments = ${quote(`"${root}"`)}
$link.WorkingDirectory = ${quote(root)}
$link.IconLocation = ${quote(join(root, "build", "icon.ico") + ",0")}
$link.Description = 'Codebit a partir da pasta do projeto'
$link.Save()
Write-Output $path
`;
const path = execFileSync("powershell", ["-NoProfile", "-Command", script], {
  encoding: "utf8",
}).trim();
console.log("Atalho criado:", path);
