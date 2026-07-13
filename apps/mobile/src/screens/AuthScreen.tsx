import React, { useState } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView, Switch, View } from 'react-native'
import { errMessage } from '@p2f/shared'
import { useApp } from '../context/AppContext'
import { Button, Card, ErrorText, Input, Label, Screen, Title } from '../components/Primitives'

export function AuthScreen ({ mode }: { mode: 'setup' | 'login' }): React.JSX.Element {
  const { completeSetup, completeLogin, changeServer, serverUrl } = useApp()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [remember, setRemember] = useState(true)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const onSubmit = async (): Promise<void> => {
    if (!username.trim() || !password) return
    setLoading(true)
    setError('')
    try {
      if (mode === 'setup') {
        await completeSetup(username.trim(), password, remember)
      } else {
        await completeLogin(username.trim(), password, remember)
      }
    } catch (err) {
      setError(errMessage(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Screen style={{ justifyContent: 'center', padding: 20 }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled">
          <Card>
            <Title>{mode === 'setup' ? 'Create the admin account' : 'Sign in'}</Title>
            <Label muted>
              {mode === 'setup'
                ? `No account exists on ${serverUrl.replace(/^https?:\/\//, '')} yet — pick a username and password for the admin account.`
                : `Signed out of ${serverUrl.replace(/^https?:\/\//, '')}.`}
            </Label>
            <Input placeholder="Username" autoCapitalize="none" autoCorrect={false}
              value={username} onChangeText={setUsername} style={{ marginTop: 14 }} />
            <Input placeholder="Password" secureTextEntry value={password} onChangeText={setPassword}
              onSubmitEditing={() => { void onSubmit() }} style={{ marginTop: 10 }} />
            <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12, gap: 10 }}>
              <Switch value={remember} onValueChange={setRemember} />
              <Label>Remember me on this device (stored in the keychain)</Label>
            </View>
            <ErrorText>{error}</ErrorText>
            <View style={{ marginTop: 14 }}>
              <Button
                title={mode === 'setup' ? 'Create account' : 'Sign in'}
                onPress={() => { void onSubmit() }}
                loading={loading}
                disabled={!username.trim() || !password}
              />
            </View>
            <View style={{ marginTop: 10 }}>
              <Button title="Use a different server" variant="secondary" onPress={() => { void changeServer() }} />
            </View>
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}
