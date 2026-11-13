import { type ButtonHTMLAttributes, forwardRef } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'danger'
export type ButtonSize = 'md' | 'lg'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  full?: boolean
  loading?: boolean
}

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 active:bg-brand-800 disabled:opacity-50 focus-visible:outline-brand-600 shadow-xs',
  secondary: 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-100 active:bg-slate-200 disabled:opacity-50 focus-visible:outline-slate-500 shadow-xs',
  danger: 'bg-white text-rose-700 border border-rose-300 hover:bg-rose-50 active:bg-rose-100 disabled:opacity-50 focus-visible:outline-rose-500 shadow-xs',
}

const SIZES: Record<ButtonSize, string> = {
  md: 'min-h-[44px] px-3.5 py-2 text-sm',
  lg: 'min-h-[48px] px-4 py-2.5 text-sm',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', full = false, loading = false, disabled, className = '', children, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-1.5 rounded-xl font-semibold whitespace-nowrap transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ${VARIANTS[variant]} ${SIZES[size]} ${full ? 'w-full' : ''} ${className}`}
      {...rest}
    >
      {children}
    </button>
  )
})
