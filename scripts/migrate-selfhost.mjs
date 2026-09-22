// Selects the self-hosted migration transport without changing schema logic.
// Defaults preserve existing deployments: MySQL/MariaDB remains the backend
// when DATABASE_BACKEND is unset.
const backend = process.env.DATABASE_BACKEND || "mysql";
if (backend === "mysql") await import("./migrate-mysql.mjs");
else if (backend === "sqlite") await import("./migrate-sqlite.mjs");
else throw new Error(`Unsupported DATABASE_BACKEND "${backend}"; expected mysql or sqlite`);
