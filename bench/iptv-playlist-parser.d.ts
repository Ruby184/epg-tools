declare module 'iptv-playlist-parser' {
  const parser: { parse: (text: string) => { header: unknown; items: unknown[] } };
  export default parser;
}
