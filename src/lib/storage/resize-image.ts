/**
 * Client-side image resize.
 *
 * We resize before upload so phone cameras don't ship 15MB originals to the
 * tenant's storage quota. The heavy lift runs in the browser via <canvas>;
 * in Node (tests, server actions that accidentally import this) we pass the
 * input through unchanged so callers don't crash.
 *
 * Contract:
 *   - Input:  Blob | File of any raster format the browser can decode.
 *   - Output: Blob (JPEG) where the longest side is `maxDimension` px or
 *             less. Quality defaults to 0.85.
 *
 * Failure modes degrade to a passthrough of the original input rather than
 * throwing. Storage rejection caps at 50MiB (Supabase default, see
 * `supabase/config.toml [storage].file_size_limit`), so a too-big pass-
 * through still surfaces a clear error from the upload call, not here.
 */

export type ResizeOptions = {
  maxDimension?: number;
  quality?: number;
  mimeType?: string;
};

const DEFAULT_MAX = 2048;
const DEFAULT_QUALITY = 0.85;
const DEFAULT_MIME = 'image/jpeg';

/**
 * Resize a Blob/File to JPEG. In non-browser contexts returns the input
 * unchanged (we lack a canvas there).
 */
export async function resizeImage(file: Blob | File, options: ResizeOptions = {}): Promise<Blob> {
  const maxDimension = options.maxDimension ?? DEFAULT_MAX;
  const quality = options.quality ?? DEFAULT_QUALITY;
  const mimeType = options.mimeType ?? DEFAULT_MIME;

  // In Node / SSR / tests, `window` isn't defined. Pass through.
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return file;
  }

  // Some browsers (Safari < 16, some embedded webviews) throw on
  // `createImageBitmap` for certain formats. Fall back to the passthrough.
  try {
    const bitmap = await createImageBitmap(file);
    const { width, height } = bitmap;
    const longest = Math.max(width, height);

    if (longest <= maxDimension) {
      bitmap.close?.();
      // Original already fits; re-encode only if we need to change format.
      if (file.type === mimeType) return file;
    }

    const scale = longest > maxDimension ? maxDimension / longest : 1;
    const targetW = Math.round(width * scale);
    const targetH = Math.round(height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      bitmap.close?.();
      return file;
    }
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    bitmap.close?.();

    const blob: Blob | null = await new Promise((resolve) => {
      canvas.toBlob(resolve, mimeType, quality);
    });
    if (!blob) return file;
    return blob;
  } catch {
    return file;
  }
}
