import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// StrictMode removed — it double-invokes effects in dev, which
// breaks WebGPU context (canvas can only bind one context).
createRoot(document.getElementById('root')!).render(<App />)
