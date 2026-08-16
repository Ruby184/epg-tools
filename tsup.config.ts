import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };

export default defineConfig({
  entry: {
    main: 'src/main.ts',
    'xmltv/main': 'src/xmltv/main.ts',
    'cache/main': 'src/cache/main.ts',
    'grabber/main': 'src/grabber/main.ts',
    'merge/main': 'src/merge/main.ts',
    'tv-grab/main': 'src/tv-grab/main.ts',
    'cli/main': 'src/cli/main.ts',
  },
  define: {
    __PKG_VERSION__: JSON.stringify(version),
  },
  format: ['esm'],
  target: 'node20',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
});
