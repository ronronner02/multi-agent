/**
 * The team surface's Latin faces, self-hosted as WOFF2 in this package.
 *
 * Chinese renders in the host's own font (PingFang SC, Microsoft YaHei, Noto Sans CJK SC), so
 * the desktop app needs no network at all. Latin-only subsets keep the bundle to what the
 * shell actually draws; the display face is used for names and questions, the mono face for
 * diffs, hashes and counts.
 */
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
