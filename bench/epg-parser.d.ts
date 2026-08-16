declare module 'epg-parser' {
  const epgParser: { parse: (xml: string) => unknown };
  export default epgParser;
}
