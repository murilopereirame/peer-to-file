import React from 'react'
import {
  ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View,
  type TextInputProps, type ViewProps
} from 'react-native'
import { useApp } from '../context/AppContext'

export function Screen ({ children, style, ...rest }: ViewProps): React.JSX.Element {
  const { colors } = useApp()
  return (
    <View style={[{ flex: 1, backgroundColor: colors.background }, style]} {...rest}>
      {children}
    </View>
  )
}

export function Card ({ children, style, ...rest }: ViewProps): React.JSX.Element {
  const { colors } = useApp()
  return (
    <View
      style={[
        { backgroundColor: colors.surface, borderRadius: 12, padding: 14, borderWidth: 1, borderColor: colors.border },
        style
      ]}
      {...rest}
    >
      {children}
    </View>
  )
}

export function Label ({ children, muted }: { children: React.ReactNode, muted?: boolean }): React.JSX.Element {
  const { colors } = useApp()
  return <Text style={{ color: muted ? colors.textMuted : colors.text, fontSize: 14 }}>{children}</Text>
}

export function Title ({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { colors } = useApp()
  return <Text style={{ color: colors.text, fontSize: 20, fontWeight: '700', marginBottom: 8 }}>{children}</Text>
}

export function Input (props: TextInputProps): React.JSX.Element {
  const { colors } = useApp()
  return (
    <TextInput
      placeholderTextColor={colors.textMuted}
      style={[
        {
          borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 10,
          color: colors.text, backgroundColor: colors.surfaceAlt, fontSize: 15
        },
        props.style
      ]}
      {...props}
    />
  )
}

export function Button ({
  title, onPress, variant = 'primary', disabled, loading
}: {
  title: string
  onPress: () => void
  variant?: 'primary' | 'secondary' | 'danger'
  disabled?: boolean
  loading?: boolean
}): React.JSX.Element {
  const { colors } = useApp()
  const bg = variant === 'primary' ? colors.primary : variant === 'danger' ? colors.danger : colors.surfaceAlt
  const fg = variant === 'primary' || variant === 'danger' ? colors.primaryText : colors.text
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.button,
        { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.8 : 1, borderColor: colors.border, borderWidth: variant === 'secondary' ? 1 : 0 }
      ]}
    >
      {loading ? <ActivityIndicator color={fg} /> : <Text style={{ color: fg, fontWeight: '600', fontSize: 15 }}>{title}</Text>}
    </Pressable>
  )
}

export function ErrorText ({ children }: { children: React.ReactNode }): React.JSX.Element | null {
  const { colors } = useApp()
  if (!children) return null
  return <Text style={{ color: colors.danger, fontSize: 13, marginTop: 6 }}>{children}</Text>
}

const styles = StyleSheet.create({
  button: {
    paddingVertical: 12, paddingHorizontal: 16, borderRadius: 8,
    alignItems: 'center', justifyContent: 'center'
  }
})
