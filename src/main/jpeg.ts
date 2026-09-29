import { nativeImage } from "electron";
import { writeFile } from "node:fs/promises";
// Instagram takes JPEG only, 320 to 1440 px wide; the feed also needs a
// proportion between 4:5 and 1.91:1, so it is cropped at the center.
export async function prepareInstagramImage(
  src: string,
  kind: "feed" | "story",
  out: string,
) {
  let image = nativeImage.createFromPath(src);
  if (image.isEmpty()) throw new Error(`Não foi possível ler a imagem ${src}.`);
  const { width, height } = image.getSize();
  if (kind === "feed" && width / height < 0.8) {
    const h = Math.floor(width / 0.8);
    image = image.crop({
      x: 0,
      y: Math.floor((height - h) / 2),
      width,
      height: h,
    });
  } else if (kind === "feed" && width / height > 1.91) {
    const w = Math.floor(height * 1.91);
    image = image.crop({
      x: Math.floor((width - w) / 2),
      y: 0,
      width: w,
      height,
    });
  }
  if (image.getSize().width > 1440)
    image = image.resize({ width: 1440, quality: "best" });
  if (image.getSize().width < 320)
    throw new Error("A imagem precisa ter pelo menos 320 px de largura.");
  let quality = 92;
  let data = image.toJPEG(quality);
  while (data.length > 8 * 1024 * 1024 && quality > 40)
    data = image.toJPEG((quality -= 12));
  await writeFile(out, data);
  return image.getSize();
}
