export function rgbaToImageData(rgba: Uint8Array, width: number, height: number): ImageData {
  // WebGL readback is bottom-left origin; ImageData expects top-left.
  // So flip vertically.
  const flipped = new Uint8ClampedArray(rgba.length);
  const row = width * 4;
  for (let y = 0; y < height; y++) {
    const srcOff = (height - 1 - y) * row;
    const dstOff = y * row;
    flipped.set(rgba.subarray(srcOff, srcOff + row), dstOff);
  }
  return new ImageData(flipped, width, height);
}