import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Marketing site: a separate static app (pre-rendered per route) so it never shares a deploy with
// the product. VITE_APP_URL points the "Open NeuroFlow" buttons at the web app.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  ssr: { noExternal: ['framer-motion', 'lucide-react'] },
});
