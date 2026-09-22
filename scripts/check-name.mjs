import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const forbidden = String.fromCharCode(115, 97, 103, 101, 107, 105);
const pattern = new RegExp(forbidden, "i");
const ignored = new Set([".git", "node_modules", ".wrangler", ".cache", "coverage"]);
const bad = [];

function visit(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    const relative = path.relative(root, full).replaceAll("\\", "/");
    if (pattern.test(relative)) bad.push(relative);
    if (entry.isDirectory()) { visit(full); continue; }
    if (!entry.isFile()) continue;
    const bytes = fs.readFileSync(full);
    if (pattern.test(bytes.toString("utf8")) || pattern.test(bytes.toString("utf16le"))) bad.push(relative);
  }
}

visit(root);
if (bad.length) {
  process.stderr.write(`Prohibited name found in: ${[...new Set(bad)].join(", ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("Name check passed.\n");
}
