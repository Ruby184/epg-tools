import { readFileSync } from 'node:fs';
import { defineConfig } from 'tsup';

const { name, version } = JSON.parse(readFileSync('./package.json', 'utf8')) as {
  name: string;
  version: string;
};

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
    __PKG_NAME__: JSON.stringify(name),
    __PKG_VERSION__: JSON.stringify(version),
  },
  format: ['esm'],
  target: 'node20',
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
});
