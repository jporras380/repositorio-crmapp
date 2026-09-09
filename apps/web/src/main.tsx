import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@crmapp/ui/tokens.css';
import '@crmapp/ui/base.css';
import { App } from './App.tsx';

createRoot(document.getElementById('raiz')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
