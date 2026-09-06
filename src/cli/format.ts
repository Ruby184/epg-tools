/**
 * `--format`: the shape a command's report comes out in.
 *
 * Shared by `epg validate` and `epg channels`, which both answer a question
 * about a file that already exists — one document, written once, either for a
 * person to read or for a CI step to branch on.
 *
 * **Not `--reporter`**, which is a different question with an overlapping
 * vocabulary: that one is how a *run* narrates itself while it works, a stream
 * of events with no end until the run has one. A command that reads a file
 * rather than running anything has nothing for it to say.
 */

export const REPORT_FORMATS = ['text', 'json'] as const;

export type ReportFormat = (typeof REPORT_FORMATS)[number];
