import './App.css'
import { AuthProvider, useAuth } from './contexts/AuthContext'
import { ThemeProvider } from './contexts/ThemeContext'
import AppShell from './AppShell'
import LoginPage from './pages/LoginPage'

function RootContent() {
  const { user, token } = useAuth()
  return user && token ? <AppShell /> : <LoginPage />
}

export default function App() {
  return (
    <ThemeProvider>
      <AuthProvider>
        <RootContent />
      </AuthProvider>
    </ThemeProvider>
  )
}
