/** Where a `width` × `height` image goes in a `areaWidth` × `areaHeight` area: as big as fits, centered. */
export function fit(width: number, height: number, areaWidth: number, areaHeight: number): { x: number; y: number; width: number; height: number } {
  const scale = Math.min(areaWidth / width, areaHeight / height)
  const w = Math.round(width * scale)
  const h = Math.round(height * scale)
  return { x: Math.floor((areaWidth - w) / 2), y: Math.floor((areaHeight - h) / 2), width: w, height: h }
}
