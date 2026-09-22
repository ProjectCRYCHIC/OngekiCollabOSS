import fs from "node:fs";
import path from "node:path";

// Removes only the files the Vite builds generate, keeping hand-maintained
// web/ entries (AGENTS.md, .assetsignore) intact.
const web = path.resolve(import.meta.dirname, "..", "web");
for (const entry of ["index.html", "admin.html", "admin.js", "admin.css", "login.html", "login.js", "login.css", "assets"]) {
  fs.rmSync(path.join(web, entry), { recursive: true, force: true });
}
fs.mkdirSync(web, { recursive: true });
