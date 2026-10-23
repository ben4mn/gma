// Sizing prints so a photo is always shown whole: the print takes the photo's own
// shape inside the space it has, so nothing is cropped and no head is cut off.

/** The largest w×h box with the photo's aspect ratio that fits in maxW×maxH. */
export function fitBox(width, height, maxW, maxH) {
  if (!(width > 0 && height > 0)) return { width: Math.floor(maxW), height: Math.floor(maxH) };
  const scale = Math.min(maxW / width, maxH / height);
  return { width: Math.floor(width * scale), height: Math.floor(height * scale) };
}

export const HERO = Object.freeze({ mat: 18, caption: 96, noteMin: 250, gap: 28 });

/**
 * The Home slideshow print. Portraits stand full height with the sender's note
 * beside them; landscapes span the width with the words written on the mat.
 * Unknown dimensions are treated as 3:2 landscape (the img still uses contain).
 */
export function heroLayout(item, area, k = HERO) {
  const w = item?.width > 0 ? item.width : 3;
  const h = item?.height > 0 ? item.height : 2;
  if (w / h < 1) {
    const photo = fitBox(w, h, area.width - 2 * k.mat - k.gap - k.noteMin, area.height - 2 * k.mat);
    return { mode: 'portrait', photo };
  }
  const photo = fitBox(w, h, area.width - 2 * k.mat, area.height - k.mat - k.caption);
  return { mode: 'landscape', photo };
}
