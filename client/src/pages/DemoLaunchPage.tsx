import { useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiLogin } from '../api'

interface Props {
  onLogin: () => void
}

export function DemoLaunchPage({ onLogin }: Props) {
  const navigate = useNavigate()
  useEffect(() => {
    apiLogin('gc@apexconstruction.demo', 'password123')
      .then(() => { onLogin(); navigate('/dashboard', { replace: true }) })
      .catch(() => navigate('/login', { replace: true }))
  }, [])
  return <div className="py-20 text-center text-xs text-slate-400">Loading demo account…</div>
}
