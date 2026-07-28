import React from 'react'

export function Card ({
  children, className, style
}: { children: React.ReactNode, className?: string, style?: React.CSSProperties }): React.JSX.Element {
  return <div className={`card ${className ?? ''}`.trim()} style={style}>{children}</div>
}

export function Title ({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <h2 className="title">{children}</h2>
}

export function Muted ({ children, style }: { children: React.ReactNode, style?: React.CSSProperties }): React.JSX.Element {
  return <p className="muted" style={style}>{children}</p>
}

export function ErrorText ({ children }: { children?: string }): React.JSX.Element | null {
  if (!children) return null
  return <p className="error-text">{children}</p>
}

export function Input (props: React.InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  return <input className="input" {...props} />
}

export function Button ({
  children, variant = 'primary', loading, className, ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger', loading?: boolean }): React.JSX.Element {
  return (
    <button className={`btn ${variant === 'secondary' ? 'secondary' : variant === 'danger' ? 'danger' : ''} ${className ?? ''}`} disabled={rest.disabled ?? loading} {...rest}>
      {loading ? '…' : children}
    </button>
  )
}
