import { useTheme } from '../contexts/ThemeContext'

export default function ThemeToggle() {
  const { dark, toggle } = useTheme()
  return (
    <button className="theme-toggle" onClick={toggle} title={dark ? 'Switch to light mode' : 'Switch to dark mode'}>
      {dark ? '☀' : '☾'}
    </button>
  )
}
