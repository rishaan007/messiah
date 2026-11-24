import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '../utils/cn.js';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'outline' | 'ghost' | 'cyan' | 'destructive';
  size?: 'sm' | 'md' | 'lg' | 'icon';
  isLoading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      className,
      variant = 'primary',
      size = 'md',
      isLoading = false,
      children,
      disabled,
      ...props
    },
    ref
  ) => {
    const baseStyles =
      'inline-flex items-center justify-center font-medium rounded-lg transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[#090A0F] disabled:opacity-50 disabled:pointer-events-none select-none active:scale-[0.98]';

    const variants = {
      primary:
        'bg-[#1E2536] text-[#F0F4FC] hover:bg-[#2A344D] border border-[#2A344D] hover:border-[#384566] focus-visible:ring-[#00F0FF]',
      secondary:
        'bg-[#12151E] text-[#94A3B8] hover:text-[#F0F4FC] hover:bg-[#181C28] border border-[#1E2536] focus-visible:ring-[#00F0FF]',
      outline:
        'border border-[#2A344D] text-[#94A3B8] hover:text-[#F0F4FC] hover:border-[#00F0FF]/50 hover:bg-[#00F0FF]/5 focus-visible:ring-[#00F0FF]',
      ghost:
        'text-[#94A3B8] hover:text-[#F0F4FC] hover:bg-[#181C28] focus-visible:ring-[#00F0FF]',
      cyan:
        'bg-[#00F0FF] text-[#090A0F] font-semibold hover:bg-[#00D8E6] shadow-[0_0_20px_rgba(0,240,255,0.25)] focus-visible:ring-[#00F0FF]',
      destructive:
        'bg-[#FF3366]/10 text-[#FF3366] border border-[#FF3366]/30 hover:bg-[#FF3366]/20 focus-visible:ring-[#FF3366]',
    };

    const sizes = {
      sm: 'text-xs px-2.5 py-1.5 h-8 gap-1.5',
      md: 'text-sm px-4 py-2 h-10 gap-2',
      lg: 'text-base px-6 py-2.5 h-12 gap-2.5',
      icon: 'h-9 w-9 p-0',
    };

    return (
      <button
        ref={ref}
        disabled={disabled || isLoading}
        className={cn(baseStyles, variants[variant], sizes[size], className)}
        {...props}
      >
        {isLoading && (
          <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin mr-2" />
        )}
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';
