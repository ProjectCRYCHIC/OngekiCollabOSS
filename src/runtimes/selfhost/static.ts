import { readFile, stat } from "node:fs/promises";
import { join, normalize, resolve, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

function notFound(): Response {
  return new Response(null, { status: 404 });
}

function fileResponse(path: string, method: string): Promise<Response> {
  return readFile(path).then((data) => {
    const type = CONTENT_TYPES[path.slice(path.lastIndexOf("."))] ?? "application/octet-stream";
    const headers = new Headers({ "content-type": type });
    // Hashed asset filenames are safe to cache forever; documents revalidate.
    if (path.includes(`${join("assets")}`)) headers.set("cache-control", "public, max-age=31536000, immutable");
    return new Response(method === "HEAD" ? null : new Uint8Array(data), { status: 200, headers });
  }).catch(() => notFound());
}

/** Serves the shared web/ build output (board + admin console). Paths resolve
 *  strictly inside the web root. */
export function serveStaticFrom(webRoot: string): (request: Request) => Promise<Response> {
  const root = resolve(webRoot);
  return async (request: Request) => {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(request.url).pathname); }
    catch { return notFound(); }
    if (pathname.endsWith("/")) pathname += "index.html";
    const target = resolve(root, "." + normalize(pathname).replaceAll("\\", "/"));
    if (target !== root && !target.startsWith(root + sep)) return notFound();
    try {
      const info = await stat(target);
      if (info.isDirectory()) return fileResponse(join(target, "index.html"), request.method);
    } catch { return notFound(); }
    return fileResponse(target, request.method);
  };
}

/** Admin console assets with the same hardening headers as the Worker serves. */
export function serveAdminStaticFrom(webRoot: string, loginEnabled: boolean): (request: Request, assetPath: string) => Promise<Response> {
  const root = resolve(webRoot);
  const headers = () => new Headers({
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  const file = async (name: string) => {
    try {
      const data = await readFile(join(root, name));
      const headers_ = headers();
      headers_.set("content-type", CONTENT_TYPES[name.slice(name.lastIndexOf("."))] ?? "application/octet-stream");
      return new Response(new Uint8Array(data), { status: 200, headers: headers_ });
    } catch {
      return new Response(null, { status: 404 });
    }
  };
  return (request, assetPath) => {
    if (request.method !== "GET" && request.method !== "HEAD") return Promise.resolve(new Response(null, { status: 405 }));
    if (assetPath === "/admin.js") return file("admin.js");
    if (assetPath === "/admin.css") return file("admin.css");
    if (loginEnabled && assetPath === "/admin/login") return file("login.html");
    return file("admin.html");
  };
}
