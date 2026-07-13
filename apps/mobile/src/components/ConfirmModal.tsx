import React, { useState } from 'react'
import { Modal, View } from 'react-native'
import { useApp } from '../context/AppContext'
import { Button, Card, ErrorText, Label, Title } from './Primitives'

export function ConfirmModal ({
  visible, title, message, confirmLabel = 'Delete', onCancel, onConfirm
}: {
  visible: boolean
  title: string
  message: string
  confirmLabel?: string
  onCancel: () => void
  onConfirm: () => Promise<void>
}): React.JSX.Element {
  const { colors } = useApp()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const confirm = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await onConfirm()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setBusy(false)
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={{ flex: 1, backgroundColor: '#00000088', justifyContent: 'center', padding: 24 }}>
        <Card style={{ backgroundColor: colors.surface }}>
          <Title>{title}</Title>
          <Label muted>{message}</Label>
          <ErrorText>{error}</ErrorText>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
            <View style={{ flex: 1 }}><Button title="Cancel" variant="secondary" onPress={onCancel} /></View>
            <View style={{ flex: 1 }}><Button title={confirmLabel} variant="danger" onPress={() => { void confirm() }} loading={busy} /></View>
          </View>
        </Card>
      </View>
    </Modal>
  )
}
