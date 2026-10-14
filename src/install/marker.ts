/**
 * The install marker file name. It lives in its own module so lower-level
 * helpers (for example the Windows Dashboard autostart registration) can
 * verify "this directory is a managed CrewDispatch installation" without importing
 * the whole installer manager back into it.
 */
export const INSTALL_MARKER = ".jobquay-install.json";
