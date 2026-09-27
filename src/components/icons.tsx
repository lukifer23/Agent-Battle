import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement>;

export function BoardMark(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <rect x="2" y="2" width="10" height="10" rx="1" />
      <rect x="12" y="12" width="10" height="10" rx="1" />
      <rect x="12" y="2" width="10" height="10" rx="1" opacity="0.35" />
      <rect x="2" y="12" width="10" height="10" rx="1" opacity="0.35" />
    </svg>
  );
}

export function RefreshCw(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  );
}

export function ArrowUpRight(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <line x1="7" y1="17" x2="17" y2="7" />
      <polyline points="7 7 17 7 17 17" />
    </svg>
  );
}

export function ChevronDown(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}

export function Trophy(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      <path d="M8 4h8v4a4 4 0 0 1-8 0z" />
      <path d="M8 5H5a3 3 0 0 0 3 3" />
      <path d="M16 5h3a3 3 0 0 1-3 3" />
      <line x1="12" y1="12" x2="12" y2="17" />
      <path d="M8 20h8" />
      <path d="M9 17h6" />
    </svg>
  );
}
