import { createRoot } from 'react-dom/client';
import { App } from './App';
import { bootstrapToken } from './lib/auth';
import { initClientSettings } from './lib/client-settings';
import { initTheme } from './lib/theme';
import './styles/app.css';

initTheme();
initClientSettings();
bootstrapToken();
createRoot(document.getElementById('root')!).render(<App />);
