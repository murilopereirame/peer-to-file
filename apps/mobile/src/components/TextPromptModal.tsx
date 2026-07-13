import React, { useEffect, useState } from 'react'
import { Modal, View } from 'react-native'
import { useApp } from '../context/AppContext'
import { Button, Card, ErrorText, Input, Title } from './Primitives'

export function TextPromptModal ({
  visible, title, initialValue = '', confirmLabel = 'Save', onCancel, onConfirm
}: {
  visible: boolean
  title: string
  initialValue?: string
  confirmLabel?: string
  onCancel: () => void
  onConfirm: (value: string) => Promise<void>
}): React.JSX.Element {
  const { colors } = useApp()
  const [value, setValue] = useState(initialValue)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => { if (visible) { setValue(initialValue); setError('') } }, [visible, initialValue])

  const confirm = async (): Promise<void> => {
    if (!value.trim()) return
    setBusy(true)
    setError('')
    try {
      await onConfirm(value.trim())
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View style={{ flex: 1, backgroundColor: '#00000088', justifyContent: 'center', padding: 24 }}>
        <Card style={{ backgroundColor: colors.surface }}>
          <Title>{title}</Title>
          <Input value={value} onChangeText={setValue} autoFocus onSubmitEditing={() => { void confirm() }} />
          <ErrorText>{error}</ErrorText>
          <View style={{ flexDirection: 'row', gap: 10, marginTop: 14 }}>
            <View style={{ flex: 1 }}><Button title="Cancel" variant="secondary" onPress={onCancel} /></View>
            <View style={{ flex: 1 }}>
              <Button title={confirmLabel} onPress={() => { void confirm() }} loading={busy} disabled={!value.trim()} />
            </View>
          </View>
        </Card>
      </View>
    </Modal>
  )
}
