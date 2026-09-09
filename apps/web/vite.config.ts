import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

const produccion = process.env['NODE_ENV'] === 'production';

export default defineConfig({
  plugins: [react()],
  css: {
    modules: {
      // En desarrollo el DOM lleva `Componente__clase`: quien revisa lee el
      // nombre del archivo y la clase sin abrir el JSX (ADR-010).
      generateScopedName: produccion ? '[hash:base64:6]' : '[name]__[local]',
    },
  },
  server: {
    port: 5173,
    // Mismo origen que la API en desarrollo: sin CORS, sin credenciales
    // cruzadas. En producción la sirve el mismo host detrás de /api.
    proxy: {
      '/api': {
        target: process.env['API_PROXY'] ?? 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (ruta) => ruta.replace(/^\/api/, ''),
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    css: { modules: { classNameStrategy: 'non-scoped' } },
  },
});
