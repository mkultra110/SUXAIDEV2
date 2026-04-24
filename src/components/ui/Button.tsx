import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { Spinner } from './Spinner';
import './Button.css';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  fullWidth?: boolean;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  leftIcon,
  rightIcon,
  fullWidth,
  disabled,
  className = '',
  children,
  ...rest
}: ButtonProps) {
  const classes = [
    'sx-btn',
    `sx-btn--${variant}`,
    `sx-btn--${size}`,
    fullWidth ? 'sx-btn--full' : '',
    loading ? 'sx-btn--loading' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button className={classes} disabled={disabled || loading} {...rest}>
      {loading ? (
        <span className="sx-btn__spinner"><Spinner size={14} /></span>
      ) : (
        leftIcon && <span className="sx-btn__icon">{leftIcon}</span>
      )}
      <span className="sx-btn__label">{children}</span>
      {rightIcon && !loading && <span className="sx-btn__icon">{rightIcon}</span>}
    </button>
  );
}
