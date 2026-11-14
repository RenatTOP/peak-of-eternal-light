import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  base: "./",
  build: { chunkSizeWarningLimit: 600 }, // the globe (three.js) is a separate lazy ~540 kB chunk
  server: { port: 5173 },
  test: { environment: "node", include: ["test/**/*.test.ts"] },
});
