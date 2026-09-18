import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@crmapp/ui/tokens.css';
import '@crmapp/ui/base.css';
import { App } from './App.tsx';
import { arrancarApariencia } from './vista/apariencia.ts';

// Antes de pintar: si se aplicara dentro de un componente, la primera imagen
// sería la del tema por defecto y cambiaría a la vista — el parpadeo blanco
// que hace daño de noche.
arrancarApariencia();

createRoot(document.getElementById('raiz')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
