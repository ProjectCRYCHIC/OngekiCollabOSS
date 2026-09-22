import path from "node:path";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const normalizeHtmlNewlines = {
  name: "normalize-html-newlines",
  transformIndexHtml: (html: string) => html.replaceAll("\r\n", "\n"),
};

// The self-hosted sign-in page is served at /admin/login with the same
// fixed-name discipline as the admin console: /login.js and /login.css.
export default defineConfig({
  root,
  publicDir: false,
  plugins: [normalizeHtmlNewlines, vue()],
  build: {
    outDir: path.resolve(root, "../web"),
    emptyOutDir: false,
    rollupOptions: {
      input: { login: path.resolve(root, "login.html") },
      output: {
        inlineDynamicImports: true,
        entryFileNames: "login.js",
        chunkFileNames: "login.js",
        assetFileNames: "login.[ext]",
      },
    },
  },
});
