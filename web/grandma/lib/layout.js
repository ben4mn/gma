// Sizing prints so a photo is always shown whole: the print takes the photo's own
// shape inside the space it has, so nothing is cropped and no head is cut off.

/** The largest w×h box with the photo's aspect ratio that fits in maxW×maxH. */
export function fitBox(width, height, maxW, maxH) {
  if (!(width > 0 && height > 0)) return { width: Math.floor(maxW), height: Math.floor(maxH) };
  const scale = Math.min(maxW / width, maxH / height);
  return { width: Math.floor(width * scale), height: Math.floor(height * scale) };
}

export const HERO = Object.freeze({ mat: 18, caption: 88, noteMin: 250, gap: 28, centerSlack: 48 });

/** Home's photo area (grandma.css: .stage--home's first column and height). */
export const HERO_AREA = Object.freeze({ width: 784, height: 640 });

/**
 * The Home slideshow print. Portraits stand full height with the sender's note
 * beside them; landscapes span the width with the words written on the mat.
 * Unknown dimensions are treated as 3:2 landscape (the img still uses contain).
 * A landscape short enough to leave more than `centerSlack` px free is centred.
 */
export function heroLayout(item, area, k = HERO) {
  const w = item?.width > 0 ? item.width : 3;
  const h = item?.height > 0 ? item.height : 2;
  if (w / h < 1) {
    const photo = fitBox(w, h, area.width - 2 * k.mat - k.gap - k.noteMin, area.height - 2 * k.mat);
    return { mode: 'portrait', photo, centered: false };
  }
  const photo = fitBox(w, h, area.width - 2 * k.mat, area.height - k.mat - k.caption);
  // A very wide photo (a panorama) leaves a band of empty paper below its print:
  // it stands in the middle of the area instead, so the space looks meant.
  const slack = area.height - (photo.height + k.mat + k.caption);
  return { mode: 'landscape', photo, centered: slack > k.centerSlack };
}

/**
 * The open photo (grandma.css: .viewer-main's first cell, 656 x 532, with a 16 px
 * mat). Landscapes and squares fill that cell above the reactions; portraits,
 * which need height rather than width, stand the full height of the cell with
 * the sender's note beside them ('pair'), so the space either side isn't wasted.
 */
export const OPEN = Object.freeze({ cell: Object.freeze({ width: 656, height: 532 }), mat: 16 });

export function openLayout(item, k = OPEN) {
  const w = item?.width > 0 ? item.width : 3;
  const h = item?.height > 0 ? item.height : 2;
  const photo = fitBox(w, h, k.cell.width - 2 * k.mat, k.cell.height - 2 * k.mat);
  return { mode: w / h < 1 ? 'pair' : 'cell', photo };
}

/**
 * The "Sent" screen's print (grandma.css .sent-print, a 16 px mat): the photo
 * whole, in its own shape, so a portrait keeps its heads.
 */
export const SENT = Object.freeze({ width: 424, height: 400 });

export function sentLayout(item, box = SENT) {
  return fitBox(item?.width, item?.height, box.width, box.height);
}
