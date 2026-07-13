export interface ThemeColors {
  background: string
  surface: string
  surfaceAlt: string
  border: string
  text: string
  textMuted: string
  primary: string
  primaryText: string
  danger: string
  success: string
  warning: string
}

export const lightColors: ThemeColors = {
  background: '#f4f5f7',
  surface: '#ffffff',
  surfaceAlt: '#eef0f3',
  border: '#d8dbe0',
  text: '#1a1c20',
  textMuted: '#5b6270',
  primary: '#2d6ae0',
  primaryText: '#ffffff',
  danger: '#c0392b',
  success: '#1f9d55',
  warning: '#c98a12'
}

export const darkColors: ThemeColors = {
  background: '#14161a',
  surface: '#1e2126',
  surfaceAlt: '#262a31',
  border: '#33383f',
  text: '#e9ebee',
  textMuted: '#9aa2ad',
  primary: '#5b8ff5',
  primaryText: '#0a1220',
  danger: '#e0685c',
  success: '#4fce85',
  warning: '#e0b04d'
}

export type ThemeMode = 'light' | 'dark'

export function colorsFor (mode: ThemeMode): ThemeColors {
  return mode === 'dark' ? darkColors : lightColors
}
