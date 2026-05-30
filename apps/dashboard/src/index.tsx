import { getRegistry } from "./host";
import { App } from "./App";

// Plugin entry: the dashboard loads this bundle by URL, then we register our
// root component under the "workflows" name. The host owns the React tree and
// renders App as an ordinary component (no createRoot of our own).
getRegistry().register("workflows", App);
