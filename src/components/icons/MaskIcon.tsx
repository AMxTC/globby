export function MaskIcon({
  size = 14,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      className={className}
    >
      <g transform="matrix(0.666667,0,0,0.487687,0,2.14775)">
        <path
          d="M24,-1.341L24,25.399L0,25.399L0,-1.341L24,-1.341ZM12,3.825C8.7,3.825 6.02,7.488 6.02,12C6.02,16.512 8.7,20.175 12,20.175C15.3,20.175 17.98,16.512 17.98,12C17.98,7.488 15.3,3.825 12,3.825Z"
          fill="currentColor"
        />
      </g>
    </svg>
  );
}
