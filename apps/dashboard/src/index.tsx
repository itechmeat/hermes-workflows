import { getRegistry } from "./host";
import { App } from "./App";

// Plugin entry: the dashboard loads this bundle by URL, then we register our
// root component under the "hermes-workflows" name. The host looks the component
// up by the manifest `name`, so this MUST match manifest.json exactly or the tab
// renders NO_REGISTER. The host owns the React tree and renders App as an
// ordinary component (no createRoot of our own).
getRegistry().register("hermes-workflows", App);
