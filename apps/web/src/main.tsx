import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { App } from './App.js'
import { UpdatePrompt } from './offline/UpdatePrompt.js'
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
        {/*
          Mounted here rather than inside <App /> so that registering the
          service worker never waits on anything. <App /> returns early while
          it asks the server who you are, and a user whose first ever visit is
          from a pit box with no signal would then never get a service worker
          at all — the app would be permanently unable to work offline, which
          is precisely backwards.
        */}
        <UpdatePrompt />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
)
