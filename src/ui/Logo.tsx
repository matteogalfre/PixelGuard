import Svg, { Rect } from 'react-native-svg';

// Le logo : une flèche vers le bas en pixels (5 × 5) sur fond violet.
export const ARROW = [
  '..X..',
  '..X..',
  'X.X.X',
  '.XXX.',
  '..X..',
];

export function Logo({ size = 32 }: { size?: number }) {
  const cell = 13;
  const gap = 4;
  const grid = 5 * cell + 4 * gap; // 81
  const box = 120;
  const start = (box - grid) / 2;
  return (
    // Décoratif : le nom « PixelGuard » est toujours écrit à côté.
    <Svg width={size} height={size} viewBox={`0 0 ${box} ${box}`} accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Rect x={0} y={0} width={box} height={box} rx={28} fill="#7C6CFF" />
      {ARROW.flatMap((row, r) =>
        row.split('').map((c, col) => (
          <Rect
            key={`${r}-${col}`}
            x={start + col * (cell + gap)}
            y={start + r * (cell + gap)}
            width={cell}
            height={cell}
            rx={3}
            fill="#FFFFFF"
            opacity={c === 'X' ? 1 : 0.22}
          />
        )),
      )}
    </Svg>
  );
}
