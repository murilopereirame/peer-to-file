import React, { useState } from 'react'
import { KeyboardAvoidingView, Platform, ScrollView } from 'react-native'
import { errMessage } from '@p2f/shared'
import { useApp } from '../context/AppContext'
import { Button, Card, ErrorText, Input, Label, Screen, Title } from '../components/Primitives'

export function ServerScreen (): React.JSX.Element {
  const { connectToServer } = useApp()
  const [url, setUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const onConnect = async (): Promise<void> => {
    if (!url.trim()) return
    setLoading(true)
    setError('')
    try {
      await connectToServer(url)
    } catch (err) {
      setError(`Could not reach that server: ${errMessage(err)}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Screen style={{ justifyContent: 'center', padding: 20 }}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView keyboardShouldPersistTaps="handled">
          <Card>
            <Title>Connect to a server</Title>
            <Label muted>
              peer-to-file has no built-in server discovery — enter the address of the
              peer-to-file server you (or someone on your network) is already running,
              e.g. your WireGuard peer's address.
            </Label>
            <Input
              placeholder="10.0.0.1:8000 or https://files.example.com"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              value={url}
              onChangeText={setUrl}
              onSubmitEditing={() => { void onConnect() }}
              style={{ marginTop: 14 }}
            />
            <ErrorText>{error}</ErrorText>
            <Button title="Connect" onPress={() => { void onConnect() }} loading={loading} disabled={!url.trim()} />
            <Label muted>
              {'\n'}Tip: if the server isn't reachable, check that you're on the same VPN
              or network it's bound to — see the peer-to-file README for details.
            </Label>
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  )
}
