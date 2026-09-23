import { createRoot } from 'react-dom/client';
import { bootstrapToken } from './lib/auth';
import { initClientSettings } from './lib/client-settings';
import { captureHostParam } from './lib/editor-links';
import { initTheme } from './lib/theme';
import './styles/app.css';

initTheme();
initClientSettings();
// Order matters: captureHostParam reads the #invite= fragment (its local-mode
// signal) that bootstrapToken strips.
if (import.meta.env.VITE_PUDDLE_REMOTE_SERVICE) {
  if (/^\/faq\/?$/.test(location.pathname)) {
    // Public setup documentation must not depend on sign-in or relay availability.
    void import('./features/faq/FaqPage').then(({ FaqPage }) =>
      createRoot(document.getElementById('root')!).render(<FaqPage />),
    );
  } else {
    void import('./features/remote/RemoteApp').then(({ RemoteApp }) =>
      createRoot(document.getElementById('root')!).render(<RemoteApp />),
    );
  }
} else {
  captureHostParam();
  void bootstrapToken().then(async () => {
    const { App } = await import('./App');
    createRoot(document.getElementById('root')!).render(<App />);
  });
}
