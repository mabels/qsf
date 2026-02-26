import path from "node:path";
import tsconfigPaths from "vite-tsconfig-paths";
import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

const cementSrc = path.resolve("node_modules/@adviser/cement/src");

export default defineWorkersConfig({
  plugins: [tsconfigPaths()],
  resolve: {
    alias: {
      "@adviser/cement/import-meta-env": path.join(cementSrc, "import-meta-env.module.ts"),
      "@adviser/cement": path.join(cementSrc, "index.ts"),
    },
  },
  test: {
    name: "cf-runtime",
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.test.toml" },
      },
    },
    include: ["src/**/*test.?(c|m)[jt]s?(x)"],
  },
});
