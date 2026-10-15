import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The Docker image (Dockerfile) builds with NEXT_OUTPUT=standalone; Vercel builds stay as before.
  output: process.env.NEXT_OUTPUT === "standalone" ? "standalone" : undefined,
  // PGlite ships a WASM build of Postgres plus data files; keep it out of the bundler
  // so it loads them from node_modules at runtime.
  serverExternalPackages: ["@electric-sql/pglite"],
  // Sandbox mode applies the SQL migrations at boot, so the migration files and the
  // PGlite runtime assets must be part of the serverless function bundle.
  outputFileTracingIncludes: {
    "/**": [
      "./drizzle/**/*",
      "./node_modules/@electric-sql/pglite/dist/*.wasm",
      "./node_modules/@electric-sql/pglite/dist/*.data",
    ],
  },
  poweredByHeader: false,
};

export default nextConfig;
