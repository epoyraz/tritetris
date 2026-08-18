import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { net } from './net'
import './styles.css'

net.connect()

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
