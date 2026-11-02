// File C: tiện ích chuỗi
export function slugify(text) {
  return text.toLowerCase().replace(/\s+/g, '-');
}
