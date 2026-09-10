import { defineConfig } from 'vite';

export default defineConfig({
  build: { rollupOptions: { input: { main: 'index.html', preview: 'preview.html' } } },
  server: { proxy: { '/api': 'http://127.0.0.1:5181' } },
});
