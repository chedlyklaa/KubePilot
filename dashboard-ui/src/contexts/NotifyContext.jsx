import { createContext, useContext } from 'react'

export const NotifyCtx = createContext(() => {})
export const useNotify = () => useContext(NotifyCtx)
