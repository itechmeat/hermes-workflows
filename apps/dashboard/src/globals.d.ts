// Build-time constants injected by vite.config.ts / vitest.config.ts `define`:
// the plugin version read from this package's manifest and the monotonic build
// counter read from build-number.json, shown in the header as `vX.Y.Z-bN`.
declare const __PLUGIN_VERSION__: string;
declare const __PLUGIN_BUILD__: number;
