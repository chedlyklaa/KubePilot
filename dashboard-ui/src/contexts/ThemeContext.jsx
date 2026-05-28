import { createContext, useContext, useState, useCallback } from 'react'

const ThemeCtx = createContext(null)
export const useTheme = () => useContext(ThemeCtx)

export function ThemeProvider({ children }) {
  const [dark, setDark] = useState(() => localStorage.getItem('k8s_theme') !== 'light')

  const toggle = useCallback(() => {
    setDark(d => {
      const next = !d
      localStorage.setItem('k8s_theme', next ? 'dark' : 'light')
      return next
    })
  }, [])

  return (
    <ThemeCtx.Provider value={{ dark, toggle }}>
      <div data-theme={dark ? 'dark' : 'light'}>
        {children}
      </div>
    </ThemeCtx.Provider>
  )
}
