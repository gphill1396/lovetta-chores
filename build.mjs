// Bundles src/app.tsx (plus the seed JSON) into dist/ for GitHub Pages.
//   node build.mjs          one-off build
//   node build.mjs --serve  build, watch and serve on http://localhost:8000
import * as esbuild from "esbuild";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";

const serve = process.argv.includes("--serve");
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist");
cpSync("index.html", "dist/index.html");
cpSync("public", "dist", { recursive: true });
writeFileSync("dist/.nojekyll", "");

const options = {
  entryPoints: ["src/app.tsx"],
  outfile: "dist/app.js",
  bundle: true,
  minify: !serve,
  sourcemap: serve,
  target: ["es2020", "safari15"],
  jsx: "automatic",
  define: { "process.env.NODE_ENV": serve ? '"development"' : '"production"' },
  logLevel: "info",
};

if (serve) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  const { port } = await ctx.serve({ servedir: "dist", port: 8000 });
  console.log(`Serving on http://localhost:${port}`);
} else {
  await esbuild.build(options);
}
