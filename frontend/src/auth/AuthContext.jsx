import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { getMe, login as loginApi, logout as logoutApi } from '../api/auth.js'
import { clearTokens, getAccessToken, setTokens } from './tokenStore.js'

const AuthCtx = createContext(null)

export function useAuth() {
  const ctx = useContext(AuthCtx)
  if (!ctx) throw new Error('useAuth must be used within <AuthProvider>')
  return ctx
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  // `loading` covers the initial "do we already have a valid session?" probe.
  const [loading, setLoading] = useState(true)

  // Bootstrap: if we have a stored access token, resolve the current user.
  useEffect(() => {
    let cancelled = false
    if (!getAccessToken()) {
      setLoading(false)
      return undefined
    }
    getMe()
      .then((u) => {
        if (!cancelled) setUser(u)
      })
      .catch(() => {
        if (!cancelled) {
          clearTokens()
          setUser(null)
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // The HTTP client fires this when a request stays unauthorized after a refresh
  // attempt — drop the user so protected routes redirect to the login screen.
  useEffect(() => {
    const onUnauthorized = () => setUser(null)
    window.addEventListener('auth:unauthorized', onUnauthorized)
    return () => window.removeEventListener('auth:unauthorized', onUnauthorized)
  }, [])

  const login = useCallback(async (email, password) => {
    const data = await loginApi({ email, password })
    setTokens(data)
    setUser(data.user)
    return data.user
  }, [])

  const logout = useCallback(async () => {
    try {
      await logoutApi()
    } catch {
      /* best-effort revoke; clear locally regardless */
    }
    clearTokens()
    setUser(null)
  }, [])

  // Let screens update the cached current user (e.g. after editing own profile).
  const patchUser = useCallback((updated) => {
    setUser((prev) => (prev && updated && prev.id === updated.id ? { ...prev, ...updated } : prev))
  }, [])

  return (
    <AuthCtx.Provider value={{ user, loading, login, logout, patchUser }}>
      {children}
    </AuthCtx.Provider>
  )
}
