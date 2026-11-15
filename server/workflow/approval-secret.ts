import { hkdfSync } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as PonderConfig from "../config.ts";

/**
 * The secret that the reply signs tool approvals with (approvals.ts). An approval comes
 * back in the messages the browser sends; the signature shows that the model asked for
 * exactly that call. PONDER_TOOL_APPROVAL_SECRET when it is set, or else one derived
 * from BETTER_AUTH_SECRET, the same on every start.
 *
 * Node code: approvals.ts's steps load it inside the step, and startup.ts checks it once,
 * so a server without either variable does not start.
 */
export class NoApprovalSecret extends Schema.TaggedError<NoApprovalSecret>()("NoApprovalSecret", {}) {
	override get message() {
		return "BETTER_AUTH_SECRET is not set.";
	}
}

export const toolApprovalSecret = Effect.gen(function* () {
	const config = yield* PonderConfig.PonderConfig;
	if (Option.isSome(config.toolApprovalSecret)) return Redacted.value(config.toolApprovalSecret.value);
	if (Option.isNone(config.betterAuthSecret)) return yield* new NoApprovalSecret();
	return Buffer.from(hkdfSync("sha256", Redacted.value(config.betterAuthSecret.value), "ponder-chat", "tool approvals v1", 32)).toString("base64url");
});
