type BrandMarkProps = {
  size?: "sm" | "md";
};

export function BrandMark({ size = "md" }: BrandMarkProps) {
  return (
    <span className={`brand-mark brand-mark-${size}`} aria-hidden="true">
      <span className="brand-route brand-route-a" />
      <span className="brand-route brand-route-b" />
      <span className="brand-node brand-node-start" />
      <span className="brand-node brand-node-end" />
    </span>
  );
}
