import * as Layer from "effect/Layer";
import * as AdminAuthEvents from "../auth/AdminAuthEvents.ts";
import * as Auth from "../auth/Auth.ts";
import * as Credits from "../credits/Credits.ts";
import * as ExtraCredits from "../credits/ExtraCredits.ts";
import * as RateLimits from "../limits/RateLimits.ts";
import * as Accounts from "../people/Accounts.ts";
import * as Invites from "../people/Invites.ts";
import * as WebBuild from "../web-build.ts";
import * as AdminActions from "./AdminActions.ts";
import * as AdminEvents from "./AdminEvents.ts";
import * as AdminReports from "./AdminReports.ts";

/**
 * People and admin: sign-in (Better Auth), accounts and invites, credits, rate limits, the
 * admin activity log and the admin API's services, and the web build for the chat page.
 * Each tier is provided by the ones below it. What they need from the platform (the
 * database, the config, Settings, Mailer, Notify, OpenRouterKey, Models) comes from the
 * app's layer (runtime/layer.ts).
 */
export const layer = AdminActions.layer.pipe(
	Layer.provideMerge(Auth.layer),
	Layer.provideMerge(Layer.mergeAll(Credits.layer, AdminAuthEvents.layer, AdminReports.layer)),
	Layer.provideMerge(Layer.mergeAll(ExtraCredits.layer, Invites.layer, Accounts.layer, AdminEvents.layer, RateLimits.layer, WebBuild.layer)),
);
