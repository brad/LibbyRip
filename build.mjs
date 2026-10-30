import { build } from 'vite';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve('.');

async function buildPageContext() {
  const result = await build({
    configFile: false,
    root: ROOT,
    build: {
      lib: {
        entry: 'src/page-context.ts',
        name: 'pageContext',
        formats: ['iife'],
        fileName: 'page-context',
      },
      outDir: 'dist',
      minify: 'terser',
      terserOptions: {
        compress: { drop_console: false },
      },
      css: { postcss: false },
      rollupOptions: {
        output: {
          format: 'iife',
          name: 'pageContext',
          compact: false,
        },
      },
    },
  });
  
  const pageContextPath = path.resolve(ROOT, 'dist/page-context.iife.js');
  if (fs.existsSync(pageContextPath)) {
    return fs.readFileSync(pageContextPath, 'utf-8');
  }
  throw new Error('page-context.js not found');
}

async function buildMain(pageContextCode) {
  const mainTsPath = path.resolve(ROOT, 'src/main.ts');
  const mainTsContent = fs.readFileSync(mainTsPath, 'utf-8');
  
  const tempMainContent = mainTsContent.replace(
    /import pageContextCode from 'virtual:page-context-code';/,
    `const pageContextCode = ${JSON.stringify(pageContextCode)};`
  );
  
  const tempMainPath = path.resolve(ROOT, 'src/main.temp.ts');
  fs.writeFileSync(tempMainPath, tempMainContent);
  
  const meta = `// ==UserScript==
// @name         LibreGRAB
// @namespace    http://tampermonkey.net/
// @version      2026-10-29-fix5
// @author       PsychedelicPalimpsest
// @description  Download all the booty! - TypeScript with OverDrive fixes
// @license      MIT
// @icon         https://www.google.com/s2/favicons?sz=64&domain=libbyapp.com
// @match        *://libbyapp.com/*
// @match        *://*.libbyapp.com/*
// @match        *://overdrive.com/*
// @match        *://*.overdrive.com/*
// @match        *://*.listen.libbyapp.com/*
// @match        *://*.listen.overdrive.com/*
// @match        *://*.read.libbyapp.com/*
// @match        *://*.read.overdrive.com/*
// @connect      images.findawayworld.com
// @connect      unpkg.com
// @grant        none
// @run-at       document-start
// ==/UserScript==
`;

  await build({
    configFile: false,
    root: ROOT,
    build: {
      lib: {
        entry: 'src/main.temp.ts',
        name: 'main',
        formats: ['iife'],
        fileName: 'main',
      },
      outDir: 'dist',
      minify: 'terser',
      terserOptions: {
        compress: { drop_console: false },
      },
      css: { postcss: false },
      rollupOptions: {
        output: {
          format: 'iife',
          name: 'main',
          compact: false,
        },
      },
    },
    plugins: [
      {
        name: 'monkey-meta',
        generateBundle(options, bundle) {
          for (const [fileName, chunk] of Object.entries(bundle)) {
            if (chunk.type === 'chunk' && fileName === 'main.iife.js') {
              chunk.code = meta + chunk.code;
            }
          }
        },
      },
    ],
  });
  
  const mainJsPath = path.resolve(ROOT, 'dist/main.iife.js');
  const userJsPath = path.resolve(ROOT, 'dist/LibreGRAB.user.js');
  if (fs.existsSync(mainJsPath)) {
    fs.renameSync(mainJsPath, userJsPath);
  }
  
  fs.writeFileSync(path.resolve(ROOT, 'dist/LibreGRAB.meta.js'), meta);
  fs.unlinkSync(tempMainPath);
  
  // Clean up intermediate page-context file
  const pageContextJsPath = path.resolve(ROOT, 'dist/page-context.iife.js');
  if (fs.existsSync(pageContextJsPath)) {
    fs.unlinkSync(pageContextJsPath);
  }
}

async function main() {
  console.log('Building page-context...');
  const pageContextCode = await buildPageContext();
  console.log('Building main with page-context...');
  await buildMain(pageContextCode);
  console.log('Build complete!');
}

main().catch(console.error);