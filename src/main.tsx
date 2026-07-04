import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { applyAEHostTheme } from './utils/theme'

applyAEHostTheme();

// StrictMode intentionally removed — its dev-mode double-mount interacts
// badly with the MTAG Switch WebSocket peer lifecycle (peer created/destroyed/
// re-created within the same tick), leaving zombie sockets on the loopback
// interface. Re-add once the peer is refactored to survive double-mount.
createRoot(document.getElementById('root')!).render(<App />)
