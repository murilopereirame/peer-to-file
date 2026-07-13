import React from 'react'
import { AppProvider, useApp } from './context/AppContext'
import { ServerScreen } from './screens/ServerScreen'
import { AuthScreen } from './screens/AuthScreen'
import { MainShell } from './screens/MainShell'

function Root (): React.JSX.Element {
  const { phase } = useApp()
  return (
    <>
      {phase === 'loading' && <div className="centered"><span className="muted">Loading…</span></div>}
      {phase === 'server' && <ServerScreen />}
      {phase === 'setup' && <AuthScreen mode="setup" />}
      {phase === 'login' && <AuthScreen mode="login" />}
      {phase === 'main' && <MainShell />}
    </>
  )
}

export default function App (): React.JSX.Element {
  return (
    <AppProvider>
      <Root />
    </AppProvider>
  )
}
