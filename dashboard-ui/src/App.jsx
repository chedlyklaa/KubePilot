import './App.css'
import { BrowserRouter } from 'react-router-dom'
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
        <BrowserRouter>
          <RootContent />
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  )
}
