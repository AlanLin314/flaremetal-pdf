import { cpSync, createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, sep } from "node:path";
import { defineConfig, type Plugin } from "vite";

const PDFJS_ASSETS = [
  ["cmaps", "node_modules/pdfjs-dist/cmaps"],
  ["standard_fonts", "node_modules/pdfjs-dist/standard_fonts"],
  ["wasm", "node_modules/pdfjs-dist/wasm"],
] as const;

function pdfjsAssets(): Plugin {
  return {
    name: "pdfjs-assets",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url ?? "").split("?")[0] ?? "");
        for (const [name, dir] of PDFJS_ASSETS) {
          const prefix = `/pdfjs/${name}/`;
          if (!url.startsWith(prefix)) continue;
          const rel = url.slice(prefix.length);
          if (!rel || rel.includes("..")) {
            res.statusCode = 400;
            res.end();
            return;
          }
          const root = join(server.config.root, dir);
          const file = normalize(join(root, rel));
          if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) {
            res.statusCode = 404;
            res.end();
            return;
          }
          if (file.endsWith(".wasm")) res.setHeader("Content-Type", "application/wasm");
          createReadStream(file).pipe(res);
          return;
        }
        next();
      });
    },
    writeBundle(options) {
      if (!options.dir) return;
      for (const [name, dir] of PDFJS_ASSETS) {
        cpSync(join(process.cwd(), dir), join(options.dir, "pdfjs", name), { recursive: true });
      }
    },
  };
}

export default defineConfig({
  plugins: [pdfjsAssets()],
  build: { target: "es2022" },
});
