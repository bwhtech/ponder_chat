/**
 * The environment variable that holds the secret WorkflowAgent signs tool approvals with
 * (experimental_toolApprovalSecret). An approval comes back in the messages the browser
 * sends; the signature shows that the model asked for exactly that call. startup.ts
 * derives the secret from BETTER_AUTH_SECRET when it is not set. No imports: the
 * workflow imports this file, and workflow code can't load Node modules.
 */
export const TOOL_APPROVAL_SECRET_ENV = "PONDER_TOOL_APPROVAL_SECRET";
