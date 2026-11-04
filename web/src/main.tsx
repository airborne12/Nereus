import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Root } from './Root.tsx';
import './styles.css';

function render() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Root />
    </StrictMode>,
  );
}

// The offline demo (npm run build:demo) answers /api/* in the browser from a data snapshot.
if (import.meta.env.MODE === 'demo') import('./demo/install.ts').then((m) => m.install()).then(render);
else render();
