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
  },
});
