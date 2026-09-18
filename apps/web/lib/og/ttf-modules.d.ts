/// The `.ttf` rule in `next.config.mjs` hands back the font's bytes as base64, not a URL.
declare module "*.ttf" {
  const base64: string;
  export default base64;
}
