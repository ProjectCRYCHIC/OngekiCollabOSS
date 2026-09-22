declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("../src/runtimes/cloudflare/worker");
    }
  }
}

export {};
