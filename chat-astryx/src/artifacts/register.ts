import { registerToolRenderer } from "../chat/tool-renderers";
import ArtifactPart from "./ArtifactPart";

// An artifact (write_artifact) is a card that opens it in the side panel.
registerToolRenderer("write_artifact", { component: ArtifactPart });
