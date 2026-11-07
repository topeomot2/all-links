import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.js';
import { loadConfig } from './config.js';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root is missing from index.html');

loadConfig().then(
  (config) =>
    createRoot(root).render(
      <StrictMode>
        <App config={config} />
      </StrictMode>,
    ),
  (err: unknown) => {
    console.error(err);
    root.textContent = 'The dashboard could not load its configuration.';
  },
);
