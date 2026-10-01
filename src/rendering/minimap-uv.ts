export function minimapUvY(
  positionY: number,
  uploadedRows: number,
  textureHeight: number,
): number {
  return (positionY * uploadedRows) / textureHeight;
}
