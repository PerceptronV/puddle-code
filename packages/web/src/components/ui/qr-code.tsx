import { useMemo } from 'react';
import QRCode from 'qrcode';

/** Vector modules from the existing encoder; no generated markup or remote image service. */
export function QrCode({ value, label }: { value: string; label: string }) {
  const qr = useMemo(() => {
    try {
      const { modules } = QRCode.create(value);
      const margin = 4; // Preserve a four-module quiet zone on every edge.
      const path: string[] = [];
      for (let row = 0; row < modules.size; row += 1) {
        for (let col = 0; col < modules.size; col += 1) {
          if (modules.get(row, col)) path.push(`M${col + margin} ${row + margin}h1v1h-1z`);
        }
      }
      return { size: modules.size + margin * 2, path: path.join('') };
    } catch {
      return null;
    }
  }, [value]);
  if (!qr)
    return <p className="text-sm text-fg-muted">QR code unavailable. Use the pairing link.</p>;
  return (
    <svg
      role="img"
      aria-label={label}
      // The white scan surface uses light-theme ink even inside a dark cockpit.
      data-theme="light"
      className="block h-auto max-w-full rounded-lg bg-paper text-fg"
      xmlns="http://www.w3.org/2000/svg"
      width={280}
      height={280}
      viewBox={`0 0 ${qr.size} ${qr.size}`}
      shapeRendering="crispEdges"
    >
      <path fill="currentColor" d={qr.path} />
    </svg>
  );
}
