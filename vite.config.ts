import { defineConfig } from 'vite';
import monkey from 'vite-plugin-monkey';
import fs from 'fs';
import path from 'path';

function pageContextPlugin() {
  let pageContextCode = '';
  return {
    name: 'page-context',
    enforce: 'post',
    buildStart() {
      this.addWatchFile(path.resolve(__dirname, 'src/page-context.ts'));
    },
    resolveId(id) {
      if (id === 'virtual:page-context-code') {
        return { id: 'virtual:page-context-code', external: false };
      }
    },
    load(id) {
      if (id === 'virtual:page-context-code') {
        return `export default ${JSON.stringify(pageContextCode || '')};`;
      }
    },
    async generateBundle(options, bundle) {
      const pageContextChunk = bundle['page-context.js'];
      if (pageContextChunk && pageContextChunk.type === 'chunk') {
        pageContextCode = pageContextChunk.code;
        // Update the virtual module
        this.emitFile({
          type: 'chunk',
          id: 'virtual:page-context-code',
          fileName: 'page-context-code.js',
          code: `export default ${JSON.stringify(pageContextCode)};`,
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [
    pageContextPlugin(),
    monkey({
      entry: 'src/main.ts',
      userscript: {
        name: 'LibreGRAB',
        namespace: 'http://tampermonkey.net/',
        version: '1.0.0',
        description: 'Download all the booty! - ID3 tagging enabled, no FFmpeg, streaming MP3',
        author: 'PsychedelicPalimpsest',
        license: 'MIT',
        match: [
          '*://libbyapp.com/*',
          '*://*.libbyapp.com/*',
          '*://overdrive.com/*',
          '*://*.overdrive.com/*',
          '*://*.listen.libbyapp.com/*',
          '*://*.listen.overdrive.com/*',
          '*://*.read.libbyapp.com/?*',
          '*://*.read.overdrive.com/?*',
        ],
        connect: ['images.findawayworld.com', 'unpkg.com'],
        icon: 'https://www.google.com/s2/favicons?sz=64&domain=libbyapp.com',
        downloadURL: 'https://update.greasyfork.org/scripts/498782/LibreGRAB.user.js',
        updateURL: 'https://update.greasyfork.org/scripts/498782/LibreGRAB.meta.js',
        runAt: 'document-start',
      },
      build: {
        fileName: 'LibreGRAB.user.js',
        metaFileName: 'LibreGRAB.meta.js',
        autoGrant: true,
        systemjs: 'cdn',
      },
      server: {
        open: true,
        prefix: 'dev:',
      },
    }),
  ],
  build: {
    minify: 'terser',
    terserOptions: {
      compress: { drop_console: false },
    },
    rollupOptions: {
      input: {
        main: 'src/main.ts',
        'page-context': 'src/page-context.ts',
      },
      output: {
        entryFileNames: '[name].js',
        dir: 'dist',
      },
    },
  },
});