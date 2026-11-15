import * as Layer from "effect/Layer";
import * as ConnectorOAuth from "./ConnectorOAuth.ts";
import * as ConnectorStore from "./ConnectorStore.ts";
import * as Connectors from "./Connectors.ts";
import * as McpClients from "./McpClients.ts";

/**
 * Every connector service, for the app's layer (runtime/layer.ts), each with what it needs
 * of the others. Below it the app gives the database, Secrets, NetGuard and the config.
 */
export const layer = Connectors.layer.pipe(
	Layer.provideMerge(McpClients.layer),
	Layer.provideMerge(McpClients.transportLayer),
	Layer.provideMerge(ConnectorOAuth.layer),
	Layer.provideMerge(ConnectorStore.layer),
);
