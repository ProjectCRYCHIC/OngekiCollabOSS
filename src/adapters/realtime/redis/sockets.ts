// Backward-compatible re-export for integrations which imported the previous
// Redis-local path. Socket ownership itself is backend-independent.
export { LocalRoomRegistry, LocalSocket } from "../local/sockets.js";
