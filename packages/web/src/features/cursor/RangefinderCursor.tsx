import { useRef } from 'react';
import { useCustomCursor } from './use-custom-cursor';

// Headings remain selectable but retain the round rangefinder spot. Consumers
// can give any other element `no-rangefinder-caret` for the same treatment.
const NO_CARET_TARGETS = 'h1, h2, h3, h4, h5, h6, .no-rangefinder-caret';

const FACET_FIELD_SIZE = 40.5;
const FACET_WIDTH = 4.05;
const FACET_HEIGHT = (FACET_WIDTH * Math.sqrt(3)) / 2;

/** The joined triangular field used by the original rangefinder cursor. */
function facetPaths(): { light: string; dark: string } {
  const light: string[] = [];
  const dark: string[] = [];
  const centre = FACET_FIELD_SIZE / 2;
  const span = Math.ceil(centre / FACET_HEIGHT) + 1;
  const point = (n: number) => Math.round(n * 100) / 100;
  const triangle = (points: Array<[number, number]>) =>
    `M${points.map(([x, y]) => `${point(x)} ${point(y)}`).join('L')}Z`;

  for (let row = -span; row < span; row += 1) {
    const top = centre + row * FACET_HEIGHT;
    const bottom = top + FACET_HEIGHT;
    const offset = (((row % 2) + 2) % 2) * (FACET_WIDTH / 2);
    for (let column = -span; column < span; column += 1) {
      const x = centre + column * FACET_WIDTH + offset;
      const up: Array<[number, number]> = [
        [x + FACET_WIDTH / 2, top],
        [x, bottom],
        [x + FACET_WIDTH, bottom],
      ];
      const down: Array<[number, number]> = [
        [x + FACET_WIDTH / 2, top],
        [x + (3 * FACET_WIDTH) / 2, top],
        [x + FACET_WIDTH, bottom],
      ];
      const visible = (points: Array<[number, number]>) => {
        const xs = points.map(([px]) => px);
        const ys = points.map(([, py]) => py);
        return (
          Math.max(...xs) > 0 &&
          Math.min(...xs) < FACET_FIELD_SIZE &&
          Math.max(...ys) > 0 &&
          Math.min(...ys) < FACET_FIELD_SIZE
        );
      };
      if (visible(up)) light.push(triangle(up));
      if (visible(down)) dark.push(triangle(down));
    }
  }

  return { light: light.join(''), dark: dark.join('') };
}

const FACETS = facetPaths();

export function RangefinderCursor() {
  const ref = useRef<HTMLDivElement>(null);
  useCustomCursor(ref, NO_CARET_TARGETS);

  return (
    <div ref={ref} className="custom-cursor rangefinder-cursor" aria-hidden="true">
      <svg
        className="rangefinder-cursor-facets"
        viewBox={`0 0 ${FACET_FIELD_SIZE} ${FACET_FIELD_SIZE}`}
        focusable="false"
      >
        <path className="rangefinder-cursor-facet-light" d={FACETS.light} />
        <path className="rangefinder-cursor-facet-dark" d={FACETS.dark} />
      </svg>
    </div>
  );
}
