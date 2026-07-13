import React from 'react'
import { ActivityIndicator, View } from 'react-native'
import { StatusBar } from 'expo-status-bar'
import { AppProvider, useApp } from './src/context/AppContext'
import { ServerScreen } from './src/screens/ServerScreen'
import { AuthScreen } from './src/screens/AuthScreen'
import { MainShell } from './src/screens/MainShell'

function Root (): React.JSX.Element {
  const { phase, colors, scheme } = useApp()
  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      {phase === 'loading' && (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      )}
      {phase === 'server' && <ServerScreen />}
      {phase === 'setup' && <AuthScreen mode="setup" />}
      {phase === 'login' && <AuthScreen mode="login" />}
      {phase === 'main' && <MainShell />}
    </View>
  )
}

export default function App (): React.JSX.Element {
  return (
    <AppProvider>
      <Root />
    </AppProvider>
  )
}
