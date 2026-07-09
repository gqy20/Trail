type BrandMarkProps = {
  size?: "sm" | "md";
};

export function BrandMark({ size = "md" }: BrandMarkProps) {
  return (
    <span className={`brand-mark brand-mark-${size}`} aria-hidden="true">
      <span className="brand-track brand-track-top" />
      <span className="brand-track brand-track-mid" />
      <span className="brand-track brand-track-dot" />
    </span>
  );
}
