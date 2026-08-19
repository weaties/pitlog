import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App.js'
import './index.css'

const queryClient = new QueryClient({
  defaultOptions: {
    // Offline-first: never throw away cached data because the network is gone.
    queries: { networkMode: 'offlineFirst', staleTime: 30_000, retry: 1 },
    mutations: { networkMode: 'offlineFirst' },
  },
})

const rootEl = document.getElementById('root')
if (!rootEl) throw new Error('#root missing from index.html')

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
