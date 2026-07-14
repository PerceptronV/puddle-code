import { createRoot } from 'react-dom/client';
import { App } from './App';
import { bootstrapToken } from './lib/auth';
import { initTheme } from './lib/theme';
import './styles/app.css';

initTheme();
bootstrapToken();
createRoot(document.getElementById('root')!).render(<App />);
