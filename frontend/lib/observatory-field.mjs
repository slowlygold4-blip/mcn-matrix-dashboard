// Decorative geometry only. Never receives account metrics or collection progress.
export const FIELD_POINTS = 72;
export const FRAME_INTERVAL = 1000 / 30;
export function orbitPoint(index, time, tiltX = 0, tiltY = 0) {
  const angle = index * 2.399963229728653;
  const y = 1 - (index / (FIELD_POINTS - 1)) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const a = angle + time * .09 + tiltX;
  const x = Math.cos(a) * r, z = Math.sin(a) * r;
  const c = Math.cos(.35 + tiltY), s = Math.sin(.35 + tiltY);
  const yy = y * c - z * s, zz = y * s + z * c;
  const perspective = 3 / (3 - zz * .55);
  return {x:x*perspective,y:yy*perspective,z:zz,opacity:.24 + (zz + 1) * .33};
}
export function shouldAnimate({reduced,disabled,hidden,intersecting}) {
  return !reduced && !disabled && !hidden && intersecting;
}
