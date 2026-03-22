/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import { installExternalLinkInterceptor } from "@/lib/external-link";

// Expose build metadata for diagnostics
try {
  document.documentElement.dataset.buildCommit = __SEREN_BUILD_COMMIT__;
  document.documentElement.dataset.buildTimestamp = __SEREN_BUILD_TIMESTAMP__;
} catch {
  // Build constants may not be defined in dev mode
}

installExternalLinkInterceptor();
render(() => <App />, document.getElementById("root") as HTMLElement);
