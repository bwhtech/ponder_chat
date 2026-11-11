/**
 * The public CDNs that an HTML artifact may load scripts, styles, fonts and images from
 * (web/artifacts/html.ts). The app's own pages allow images from them too (server/app.ts):
 * an artifact's frame is a srcdoc frame, so it is held to the app page's policy as well.
 */
export const ARTIFACT_CDNS = ["https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net", "https://unpkg.com", "https://esm.sh"];
