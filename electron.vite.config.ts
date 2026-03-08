import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { config } from 'dotenv'

const env = config().parsed ?? {}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    define: {
      'process.env.VITE_SUPABASE_URL': JSON.stringify(env.VITE_SUPABASE_URL ?? ''),
      'process.env.VITE_SUPABASE_ANON_KEY': JSON.stringify(env.VITE_SUPABASE_ANON_KEY ?? '')
    },
    build: {
      outDir: 'dist-electron/main',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src-main/main.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'dist-electron/preload',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src-main/preload.ts') }
      }
    }
  },
  renderer: {
    root: 'src',
    build: {
      outDir: resolve(__dirname, 'out'),
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/index.html') }
      }
    },
    resolve: {
      alias: { '@': resolve(__dirname, 'src') }
    },
    plugins: [react()]
  }
})
