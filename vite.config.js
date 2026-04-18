import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import monacoEditorPlugin from 'vite-plugin-monaco-editor';

// The plugin uses a CJS default export; depending on bundler wrapping
// it may come through as { default: fn } or just fn.
const monacoPlugin = typeof monacoEditorPlugin === 'function'
  ? monacoEditorPlugin
  : monacoEditorPlugin.default;

export default defineConfig({
  plugins: [
    react(),
    monacoPlugin({
      languageWorkers: ['editorWorkerService'],
    }),
  ],
  base: './',
  server: {
    port: 3000,
  },
  build: {
    outDir: 'dist',
    // QA P1-04: split the biggest deps into their own chunks so the first
    // paint isn't blocked on a single 3.79 MB JS file. Paired with the
    // core-only monaco import in TexEditor.jsx, this drops the main chunk
    // to ~300 kB (gzip) and lets the browser cache monaco / pdfjs
    // separately across releases.
    rollupOptions: {
      output: {
        manualChunks: {
          monaco: ['monaco-editor/esm/vs/editor/editor.api'],
          pdfjs: ['pdfjs-dist'],
          react: ['react', 'react-dom', 'react-dom/client'],
        },
      },
    },
  },
});
