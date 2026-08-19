/**
 * The controls everything else is built from.
 *
 * SPEC §6.2 asks for gloves-and-sunlight. In practice that means one rule
 * applied without exception: **nothing interactive is smaller than
 * `--spacing-tap`**, which is 4rem in `index.css`. A crew member wearing
 * fireproof gloves cannot hit a 32px button, and at a race they will not try
 * twice — they will write it on their hand and forget.
 */

import type { ReactNode } from 'react'
import { useId } from 'react'

type ButtonTone = 'primary' | 'default' | 'danger' | 'ghost'

const TONES: Record<ButtonTone, string> = {
  primary: 'bg-pit-accent text-pit-bg font-semibold',
  default: 'bg-pit-surface text-pit-fg border border-white/10',
  danger: 'bg-red-500/15 text-red-200 border border-red-400/30',
  ghost: 'text-pit-muted',
}

export function Button({
  children,
  tone = 'default',
  className = '',
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: ButtonTone }) {
  return (
    <button
      type="button"
      {...rest}
      className={`min-h-tap rounded-xl px-4 text-lg transition-transform active:scale-[0.98] disabled:opacity-40 ${TONES[tone]} ${className}`}
    >
      {children}
    </button>
  )
}

/**
 * A labelled control.
 *
 * `children` is a function of the generated id so the label is associated
 * explicitly rather than by nesting. Implicit association is valid HTML, but an
 * explicit `for`/`id` pair is what assistive tech handles most reliably — and
 * this is a screen people use one-handed, in gloves, in the sun.
 */
export function Field({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: (id: string) => ReactNode
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="font-medium text-pit-muted text-sm">
        {label}
      </label>
      {children(id)}
      {hint && <span className="text-pit-muted text-xs">{hint}</span>}
    </div>
  )
}

export function Input({ className = '', ...rest }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...rest}
      className={`min-h-tap rounded-xl border border-white/10 bg-pit-surface px-4 text-lg text-pit-fg placeholder:text-pit-muted/60 ${className}`}
    />
  )
}

export function Select({ className = '', ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...rest}
      className={`min-h-tap rounded-xl border border-white/10 bg-pit-surface px-4 text-lg text-pit-fg ${className}`}
    />
  )
}

export function Toggle({
  label,
  checked,
  onChange,
  hint,
}: {
  label: string
  checked: boolean
  onChange: (next: boolean) => void
  hint?: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`flex min-h-tap items-center justify-between gap-4 rounded-xl border px-4 text-left ${
        checked ? 'border-pit-accent/50 bg-pit-accent/10' : 'border-white/10 bg-pit-surface'
      }`}
    >
      <span>
        <span className="block text-lg">{label}</span>
        {hint && <span className="block text-pit-muted text-xs">{hint}</span>}
      </span>
      <span
        className={`h-7 w-12 shrink-0 rounded-full p-1 transition-colors ${checked ? 'bg-pit-accent' : 'bg-white/15'}`}
      >
        <span
          className={`block h-5 w-5 rounded-full bg-pit-bg transition-transform ${checked ? 'translate-x-5' : ''}`}
        />
      </span>
    </button>
  )
}

/**
 * Spreads the rest of its props onto the element. Without that, anything the
 * caller attaches — `data-testid`, `role`, `aria-*` — is silently swallowed,
 * which is both a testing trap and an accessibility one.
 */
export function Card({
  children,
  className = '',
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  return (
    <div {...rest} className={`rounded-xl border border-white/10 bg-pit-surface p-4 ${className}`}>
      {children}
    </div>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-pit-muted">{children}</p>
}
