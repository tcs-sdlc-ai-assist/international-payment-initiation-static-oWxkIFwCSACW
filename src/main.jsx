/**
 * Vite application entry point.
 *
 * main.jsx is the single mounting point for the intl-payment-initiation app. It
 * imports the global stylesheet and renders the root {@link App} component into
 * the `#root` element inside React's {@link React.StrictMode}. The router lives
 * exclusively inside {@link App} (which hosts the {@link BrowserRouter}), so no
 * router, provider, or layout is composed here — this file only bootstraps the
 * React tree.
 */

import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '@/App';
import '@/index.css';

const rootElement = document.getElementById('root');

if (rootElement) {
  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}