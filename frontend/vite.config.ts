import path from "node:path";
import { fileURLToPath } from "node:url";
import vue from "@vitejs/plugin-vue";
import { defineConfig } from "vite";

const root = path.dirname(fileURLToPath(import.meta.url));
const normalizeHtmlNewlines = {
  name: "normalize-html-newlines",
  transformIndexHtml: (html: string) => html.replaceAll("\r\n", "\n"),
};

export default defineConfig({
  root,
  publicDir: path.resolve(root, "public"),
  plugins: [normalizeHtmlNewlines, vue()],
  server: {
    proxy: {
      // Point the dev server at `wrangler dev` for API and live WebSocket traffic.
      "/api": { target: "http://127.0.0.1:8787", ws: true },
    },
  },
  build: {
    outDir: path.resolve(root, "../web"),
    emptyOutDir: false,
    rollupOptions: { input: { main: path.resolve(root, "index.html") } },
  },
});
