import { forwardRef } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import './Input.css';

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string | null;
  leftIcon?: ReactNode;
  rightSlot?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, error, leftIcon, rightSlot, className = '', id, ...rest },
  ref,
) {
  const autoId = id || `sx-input-${Math.random().toString(36).slice(2, 8)}`;
  return (
    <div className={`sx-field ${error ? 'sx-field--error' : ''}`}>
      {label && (
        <label className="sx-field__label" htmlFor={autoId}>
          {label}
        </label>
      )}
      <div className="sx-field__wrap">
        {leftIcon && <span className="sx-field__icon">{leftIcon}</span>}
        <input
          ref={ref}
          id={autoId}
          className={`sx-field__input ${className}`}
          aria-invalid={!!error}
          {...rest}
        />
        {rightSlot && <span className="sx-field__right">{rightSlot}</span>}
      </div>
      {error && <span className="sx-field__error">{error}</span>}
    </div>
  );
});
