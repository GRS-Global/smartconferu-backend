/** The pictures a certificate may hold, told apart by their first bytes (not by the file name). SVG is not accepted: it can carry scripts. */
export const IMAGE_KINDS = [
  {
    ext: 'png',
    mime: 'image/png',
    is: (b: Buffer) =>
      b
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    ext: 'jpg',
    mime: 'image/jpeg',
    is: (b: Buffer) => b.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])),
  },
  {
    ext: 'webp',
    mime: 'image/webp',
    is: (b: Buffer) =>
      b.subarray(0, 4).toString('latin1') === 'RIFF' &&
      b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
] as const;

export interface UploadedImage {
  originalname: string;
  size: number;
  buffer: Buffer;
}
