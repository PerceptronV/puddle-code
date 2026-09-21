import { createRoot } from 'react-dom/client';
import { App } from './App';
import { bootstrapToken } from './lib/auth';
import { initClientSettings } from './lib/client-settings';
import { captureHostParam } from './lib/editor-links';
import { initTheme } from './lib/theme';
import './styles/app.css';

initTheme();
initClientSettings();
// Order matters: captureHostParam reads the #invite= fragment (its local-mode
// signal) that bootstrapToken strips.
captureHostParam();
void bootstrapToken().then(() => createRoot(document.getElementById('root')!).render(<App />));
