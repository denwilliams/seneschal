/**
 * One cap for any document bytes staged or extracted locally.
 *
 * Keep connector-written attachments on the same budget as Slack downloads:
 * a connector must not be a way around the home-uplink/document extraction
 * limit simply because it writes its result to disk first.
 */
export const MAX_ATTACHMENT_BYTES = 12 * 1024 * 1024;
