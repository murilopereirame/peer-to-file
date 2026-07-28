import type { ThemeMode } from '@p2f/shared'
import { useTheme } from '../context/ThemeContext'
import { MonitorIcon, MoonIcon, SunIcon } from './icons'

const OPTIONS: Array<{ value: ThemeMode | null, label: string, Icon: typeof SunIcon }> = [
  { value: null, label: 'System', Icon: MonitorIcon },
  { value: 'light', label: 'Light', Icon: SunIcon },
  { value: 'dark', label: 'Dark', Icon: MoonIcon }
]

/** Segmented light/dark/system picker — `null` hands control back to the OS. */
export function ThemeToggle (): React.JSX.Element {
  const { override, setOverride } = useTheme()
  return (
    <div className="theme-toggle" role="radiogroup" aria-label="Theme">
      {OPTIONS.map(({ value, label, Icon }) => (
        <button
          key={label}
          type="button"
          role="radio"
          aria-checked={override === value}
          className={override === value ? 'active' : ''}
          onClick={() => setOverride(value)}
        >
          <Icon size={13} />
          <span className="label">{label}</span>
        </button>
      ))}
    </div>
  )
}
