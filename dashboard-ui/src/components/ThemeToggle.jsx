import { useTheme } from '../contexts/ThemeContext'

export default function ThemeToggle() {
  const { dark, toggle } = useTheme()
  return (
    <div className="theme-switcher" role="group" aria-label="Color scheme">
      <button
        className={`theme-btn ${!dark ? 'theme-btn-active' : ''}`}
        onClick={() => dark && toggle()}
        title="Light mode"
        aria-pressed={!dark}
      >
        ☀
      </button>
      <button
        className={`theme-btn ${dark ? 'theme-btn-active' : ''}`}
        onClick={() => !dark && toggle()}
        title="Dark mode"
        aria-pressed={dark}
      >
        ☾
      </button>
    </div>
  )
}
