import { defineConfig } from 'vite';

/* The window is plain files served by Tauri: no server, no Node at run time. Vite only bundles
 * src/ into dist/, which Tauri embeds in the executable. public/ (xterm, fonts, brand) is copied as is. */
export default defineConfig({
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // WebView2 (Windows), WKWebView (macOS 12+) and WebKitGTK 4.1 (Linux)
    target: ['es2021', 'chrome105', 'safari15'],
    sourcemap: true,
    chunkSizeWarningLimit: 1500
  }
});
