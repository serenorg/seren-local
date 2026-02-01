/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import { installExternalLinkInterceptor } from "@/lib/external-link";

installExternalLinkInterceptor();
render(() => <App />, document.getElementById("root") as HTMLElement);
