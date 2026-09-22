import path from "node:path";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const normalizeHtmlNewlines = {
  name: "normalize-html-newlines",
  transformIndexHtml: (html: string) => html.replaceAll("\r\n", "\n"),
};

// The admin console is reachable only through the server-authenticated /admin*
// paths (src/core/admin-api.ts whitelists /admin.html, /admin.js and
// /admin.css), so its bundle keeps those exact fixed file names instead of
// hashed assets.
export default defineConfig({
  root,
  publicDir: false,
  plugins: [normalizeHtmlNewlines, vue()],
  build: {
    outDir: path.resolve(root, "../web"),
    emptyOutDir: false,
    rollupOptions: {
      input: { admin: path.resolve(root, "admin.html") },
      output: {
        inlineDynamicImports: true,
        entryFileNames: "admin.js",
        chunkFileNames: "admin.js",
        assetFileNames: "admin.[ext]",
      },
    },
  },
});
