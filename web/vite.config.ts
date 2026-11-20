import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import wasm from 'vite-plugin-wasm';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

// The wallet app pins the hash of the compiler's integrity manifest, so the
// proving keys it fetches can only be the ones this build was made with.
const manifest = new URL('../contract/managed/proxy/compiler/contract-manifest.json', import.meta.url);
const zkVersion = existsSync(manifest) ? createHash('sha256').update(readFileSync(manifest)).digest('hex') : '';

export default defineConfig({
  plugins: [react(), wasm(), nodePolyfills({ include: ['buffer', 'process', 'util', 'stream', 'events'] })],
  define: { __KEEPROXY_ZK_VERSION__: JSON.stringify(zkVersion) },
  build: { target: 'es2022', chunkSizeWarningLimit: 8000 },
  optimizeDeps: { esbuildOptions: { target: 'es2022' } },
  server: {
    port: 5173,
    fs: { allow: ['..'] },
    proxy: { '/api': { target: 'http://127.0.0.1:8787', changeOrigin: false } },
  },
});
