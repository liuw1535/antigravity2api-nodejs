import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: '/v2/',
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/admin': {
        target: 'http://localhost:8045',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: '../public/v2',
    emptyOutDir: true,
  },
})
