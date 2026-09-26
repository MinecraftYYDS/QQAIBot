import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(root, 'dist');

// Only clear build outputs: dist/config.yaml and dist/data belong to the
// developer and must survive a rebuild.
await mkdir(dist, { recursive: true });
await rm(path.join(dist, 'bot.mjs'), { force: true });
await rm(path.join(dist, 'bot.mjs.map'), { force: true });
await rm(path.join(dist, 'public'), { recursive: true, force: true });

const result = await build({
  entryPoints: [path.join(root, 'src/index.ts')],
  outfile: path.join(dist, 'bot.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  // Everything from the SDK gets bundled (this also fixes its extensionless
  // ESM imports). Node built-ins stay external.
  external: ['node:*'],
  banner: {
    js: [
      "import { createRequire as __qqaibotCreateRequire } from 'node:module';",
      'const require = __qqaibotCreateRequire(import.meta.url);',
    ].join('\n'),
  },
});

if (result.errors.length > 0) {
  console.error(result.errors);
  process.exit(1);
}

// Static WebUI assets live next to the bundle.
const publicSrc = path.join(root, 'public');
if (existsSync(publicSrc)) {
  await cp(publicSrc, path.join(dist, 'public'), { recursive: true });
}

console.log('[build] dist/bot.mjs ready');
